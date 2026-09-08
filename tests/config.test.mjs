import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ConfigError,
  applyPreparedEdits,
  atomicLocalWrite,
  deleteRemoteSettings,
  prepareEdits,
  restrictWindowsDirectory,
  restoreEdits,
  saveRecoveryRecord,
  sha256,
  writeRemoteSettings,
} from '../scripts/config.mjs';

const base = {
  sshText: 'Host dev-linux\r\n    HostName example.invalid\r\n',
  settingsText: '{\n  // 保留注释\n  "editor.tabSize": 2\n}\n',
  host: 'dev-linux',
  localPort: 7890,
  remotePort: 17890,
};

test('局部编辑保留注释和换行，支持两端端口不同且重复执行不变', () => {
  const first = prepareEdits(base);
  const second = prepareEdits({ ...base, sshText: first.sshText, settingsText: first.settingsText });

  assert.match(first.sshText, /RemoteForward 127\.0\.0\.1:17890 127\.0\.0\.1:7890/);
  assert.match(first.sshText, /\r\n/);
  assert.match(first.settingsText, /\/\/ 保留注释/);
  assert.match(first.settingsText, /"editor\.tabSize": 2/);
  assert.equal(second.changed, false);
  assert.equal(second.sshText, first.sshText);
  assert.equal(second.settingsText, first.settingsText);
});

test('等价用户值复用但不归工具所有', () => {
  const result = prepareEdits({
    ...base,
    sshText: 'Host dev-linux\n  RemoteForward 127.0.0.1:17890 127.0.0.1:7890\n',
    settingsText: '{\n  "http.useLocalProxyConfiguration": false,\n  "http.proxy": "http://127.0.0.1:17890"\n}\n',
  });
  assert.equal(result.changed, false);
  assert.equal(result.recovery.ssh.owned, false);
  assert.equal(result.recovery.settings.owned, false);
  assert.equal(result.recovery.settings.properties['http.proxy'].owned, false);

  const bracketed = prepareEdits({
    ...base,
    sshText: 'Host dev-linux\n  RemoteForward [127.0.0.1]:17890 [127.0.0.1]:7890\n',
    settingsText: result.settingsText,
  });
  assert.equal(bracketed.changed, false);
  assert.equal(bracketed.recovery.ssh.owned, false);
});

test('扫描完整 Host 块，等价转发后出现同端口冲突仍停止', () => {
  assert.throws(() => prepareEdits({
    ...base,
    sshText: [
      'Host dev-linux',
      '  RemoteForward 127.0.0.1:17890 127.0.0.1:7890',
      '  RemoteForward 17890 127.0.0.1:7999',
      '',
    ].join('\n'),
  }), /远端端口 17890 已有不同转发映射/);

  assert.throws(() => prepareEdits({
    ...base,
    sshText: 'Host dev-linux\n  RemoteForward 17890 127.0.0.1:7890\n',
  }), /远端端口 17890 已有不同转发映射/);
});

test('JSONC 局部编辑保留 CRLF', () => {
  const settingsText = '{\r\n  // 保留注释\r\n  "editor.tabSize": 2\r\n}\r\n';
  const prepared = prepareEdits({ ...base, settingsText });
  assert.equal(prepared.settingsText.replace(/\r\n/g, '').includes('\n'), false);
  assert.equal(restoreEdits({
    sshText: prepared.sshText,
    settingsText: prepared.settingsText,
    recovery: prepared.recovery,
  }).settingsText, settingsText);
});

test('拒绝复杂 SSH config、重复目标块和不完整工具标记', () => {
  const sshCases = [
    'Include conf.d/*\nHost dev-linux\n',
    'Match all\nHost dev-linux\n',
    'Host dev-linux\nHost dev-linux\n',
    'Host dev-linux\n  # BEGIN codex-proxy-e2e\n',
    'Host dev-linux other\n',
  ];
  for (const sshText of sshCases) {
    assert.throws(() => prepareEdits({ ...base, sshText }), ConfigError);
  }
});

test('拒绝非法 JSONC、重复目标键和不同用户代理值', () => {
  const settingsCases = [
    '{ nope',
    '{ "http.proxy": "http://127.0.0.1:17890", "http.proxy": "http://127.0.0.1:17890" }',
    '{ "http.proxy": "http://user:secret@127.0.0.1:17890" }',
    '{ "http.useLocalProxyConfiguration": true }',
  ];
  for (const settingsText of settingsCases) {
    assert.throws(() => prepareEdits({ ...base, settingsText }), ConfigError);
  }
});

test('恢复精确还原原文，摘要变化时拒绝覆盖', () => {
  const prepared = prepareEdits(base);
  assert.deepEqual(
    restoreEdits({ sshText: prepared.sshText, settingsText: prepared.settingsText, recovery: prepared.recovery }),
    { sshText: base.sshText, settingsText: base.settingsText },
  );
  assert.throws(() => restoreEdits({
    sshText: `${prepared.sshText}# 用户修改\n`,
    settingsText: prepared.settingsText,
    recovery: prepared.recovery,
  }), /摘要.*不符/);
});

test('原 settings 不存在时可恢复为不存在', () => {
  const prepared = prepareEdits({ ...base, settingsText: null });
  const restored = restoreEdits({
    sshText: prepared.sshText,
    settingsText: prepared.settingsText,
    recovery: prepared.recovery,
  });
  assert.equal(restored.settingsText, null);
});

test('本地原子写入拒绝链接与摘要变化，并保留权限', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-config-'));
  const target = path.join(directory, 'config');
  const link = path.join(directory, 'link');
  try {
    await fs.writeFile(target, 'before', { mode: 0o640 });
    await fs.symlink(target, link);
    await assert.rejects(() => atomicLocalWrite({ filePath: link, expectedHash: sha256('before'), text: 'after' }), ConfigError);
    await assert.rejects(() => atomicLocalWrite({ filePath: target, expectedHash: sha256('other'), text: 'after' }), ConfigError);
    assert.equal(await fs.readFile(target, 'utf8'), 'before');
    await atomicLocalWrite({ filePath: target, expectedHash: sha256('before'), text: 'after' });
    assert.equal(await fs.readFile(target, 'utf8'), 'after');
    if (process.platform !== 'win32') assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('恢复记录目录限制失败时不创建记录', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-state-'));
  try {
    await assert.rejects(() => saveRecoveryRecord({ directory, record: { safe: true } }, {
      restrictDirectory: async () => { throw new Error('acl failed'); },
    }), /acl failed/);
    await assert.rejects(() => fs.access(path.join(directory, 'active.json')));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Windows 恢复目录 ACL 仅授予当前用户 SID', async () => {
  const calls = [];
  await restrictWindowsDirectory('C:\\state', {
    platform: 'win32',
    runProcess: async (request) => {
      calls.push(request);
      if (request.executable === 'whoami.exe') {
        return { exitCode: 0, stdout: '"DESKTOP\\user","S-1-5-21-123-456"\r\n' };
      }
      return { exitCode: 0, stdout: '' };
    },
  });
  assert.deepEqual(calls[1], {
    executable: 'icacls.exe',
    args: ['C:\\state', '/inheritance:r', '/grant:r', '*S-1-5-21-123-456:(OI)(CI)F'],
  });
});

test('恢复记录只含摘要、所有权和局部恢复信息', () => {
  const recovery = prepareEdits(base).recovery;
  const serialized = JSON.stringify(recovery);
  assert.doesNotMatch(serialized, /example\.invalid|editor\.tabSize/);
  assert.doesNotMatch(serialized, /password|token|secret/i);
  assert.match(serialized, /beforeHash/);
});

test('远端写入失败后恢复本地；恢复记录创建失败时不写用户文件', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-apply-'));
  const sshPath = path.join(directory, 'config');
  const prepared = prepareEdits(base);
  try {
    await fs.writeFile(sshPath, base.sshText);
    await assert.rejects(() => applyPreparedEdits({
      sshPath,
      prepared,
      saveRecovery: async () => {},
      writeRemote: async () => { throw new Error('remote failed'); },
    }), /remote failed/);
    assert.equal(await fs.readFile(sshPath, 'utf8'), base.sshText);

    await assert.rejects(() => applyPreparedEdits({
      sshPath,
      prepared,
      saveRecovery: async () => { throw new Error('state failed'); },
      writeRemote: async () => {},
    }), /state failed/);
    assert.equal(await fs.readFile(sshPath, 'utf8'), base.sshText);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('远端写入使用受限本地文件、私有暂存、摘要复读并清理', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-upload-'));
  const stage = '/home/sample/.codex-proxy-e2e-test';
  const remoteFile = `${stage}/settings upload.json`;
  const encoded = (value) => Buffer.from(value).toString('base64');
  const stagingStates = [];
  let localUpload = null;
  let cleaned = false;
  try {
    await writeRemoteSettings({
      options: { host: 'dev-linux' },
      remotePath: '~/.vscode-server/data/Machine/settings.json',
      expectedHash: 'missing',
      text: '{\n  "http.proxy": "http://127.0.0.1:17890"\n}\n',
      temporaryDirectory: directory,
      onStaging: async (value) => stagingStates.push(value),
    }, {
      restrictDirectory: async () => {},
      runSsh: async (_options, _script, args, _timeout, _shell, label) => {
        if (label === '检查远端写入工具') return '__CODEX_CONFIG__\nready=1\n';
        if (label === '创建远端私有暂存目录') {
          return `__CODEX_CONFIG__\nstage=${encoded(stage)}\nfile=${encoded(remoteFile)}\n`;
        }
        if (label === '写入 Remote settings') {
          assert.equal(args[0], '~/.vscode-server/data/Machine/settings.json');
          assert.equal(args[1], 'missing');
          assert.equal(args[2], '600');
          return args[5];
        }
        if (label === '清理远端暂存目录') {
          cleaned = true;
          return '__CODEX_CONFIG__\nclean=1\n';
        }
        throw new Error(`unexpected label: ${label}`);
      },
      runScp: async (_options, localFile, destination) => {
        localUpload = localFile;
        assert.equal(destination, remoteFile);
        assert.match(await fs.readFile(localFile, 'utf8'), /http\.proxy/);
        if (process.platform !== 'win32') assert.equal((await fs.stat(localFile)).mode & 0o777, 0o600);
      },
    });
    assert.deepEqual(stagingStates, [stage, null]);
    assert.equal(cleaned, true);
    await assert.rejects(() => fs.access(localUpload));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('SCP 上传失败不替换目标并清理本地与远端暂存', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-scp-fail-'));
  const stage = '/home/sample/.codex-proxy-e2e-scp-fail';
  const remoteFile = `${stage}/settings upload.json`;
  const encoded = (value) => Buffer.from(value).toString('base64');
  const stagingStates = [];
  const labels = [];
  try {
    await assert.rejects(() => writeRemoteSettings({
      options: { host: 'dev-linux' },
      remotePath: '/home/sample/settings.json',
      expectedHash: 'missing',
      text: '{}\n',
      temporaryDirectory: directory,
      onStaging: async (value) => stagingStates.push(value),
    }, {
      restrictDirectory: async () => {},
      runScp: async () => { throw new Error('SCP upload failed'); },
      runSsh: async (_options, _script, _args, _timeout, _shell, label) => {
        labels.push(label);
        if (label === '检查远端写入工具') return '__CODEX_CONFIG__\nready=1\n';
        if (label === '创建远端私有暂存目录') {
          return `__CODEX_CONFIG__\nstage=${encoded(stage)}\nfile=${encoded(remoteFile)}\n`;
        }
        if (label === '清理远端暂存目录') return '__CODEX_CONFIG__\nclean=1\n';
        throw new Error(`unexpected label: ${label}`);
      },
    }), /SCP upload failed/);
    assert.deepEqual(stagingStates, [stage, null]);
    assert.doesNotMatch(labels.join('\n'), /写入 Remote settings/);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('远端摘要异常或暂存清理失败均报告安全边界', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-remote-fail-'));
  const stage = '/home/sample/.codex-proxy-e2e-cleanup-fail';
  const remoteFile = `${stage}/settings upload.json`;
  const encoded = (value) => Buffer.from(value).toString('base64');
  const runCase = async ({ cleanupFails = false } = {}) => writeRemoteSettings({
    options: { host: 'dev-linux' },
    remotePath: '/home/sample/settings.json',
    expectedHash: 'missing',
    text: '{}\n',
    temporaryDirectory: directory,
  }, {
    restrictDirectory: async () => {},
    runScp: async () => {},
    runSsh: async (_options, _script, _args, _timeout, _shell, label) => {
      if (label === '检查远端写入工具') return '__CODEX_CONFIG__\nready=1\n';
      if (label === '创建远端私有暂存目录') {
        return `__CODEX_CONFIG__\nstage=${encoded(stage)}\nfile=${encoded(remoteFile)}\n`;
      }
      if (label === '写入 Remote settings') return 'wrong-hash\n';
      if (label === '清理远端暂存目录') {
        if (cleanupFails) throw new Error('cleanup failed');
        return '__CODEX_CONFIG__\nclean=1\n';
      }
      throw new Error(`unexpected label: ${label}`);
    },
  });
  try {
    await assert.rejects(() => runCase(), /远端替换后复读摘要不匹配/);
    await assert.rejects(() => runCase({ cleanupFails: true }), new RegExp(`远端暂存清理结果不明：${stage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('本地暂存写入失败会删除副本，删除失败时报告残留路径', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-upload-fail-'));
  const makeFileSystem = (failRemove = false) => ({
    mkdir: (...args) => fs.mkdir(...args),
    open: async (...args) => {
      const handle = await fs.open(...args);
      return {
        writeFile: async (text, encoding) => {
          await handle.writeFile(text, encoding);
          throw new Error('injected write failure');
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
    rm: async (...args) => {
      if (failRemove) throw new Error('injected cleanup failure');
      return fs.rm(...args);
    },
  });
  const input = {
    options: { host: 'dev-linux' },
    remotePath: '~/.vscode-server/data/Machine/settings.json',
    expectedHash: 'missing',
    text: '{ "http.proxy": "http://127.0.0.1:17890" }\n',
    temporaryDirectory: directory,
  };
  const dependencies = {
    restrictDirectory: async () => {},
    runScp: async () => { throw new Error('SCP 不应启动'); },
    runSsh: async () => '__CODEX_CONFIG__\nready=1\n',
  };
  try {
    await assert.rejects(() => writeRemoteSettings(input, {
      ...dependencies,
      fs: makeFileSystem(),
    }), /injected write failure/);
    assert.deepEqual(await fs.readdir(directory), []);

    await assert.rejects(() => writeRemoteSettings(input, {
      ...dependencies,
      fs: makeFileSystem(true),
    }), /无法清理本地暂存文件：.*upload-/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('仅按摘要删除本次创建的 Remote settings 并确认不存在', async () => {
  let request;
  await deleteRemoteSettings({
    options: { host: 'dev-linux' },
    remotePath: '~/.vscode-server/data/Machine/settings.json',
    expectedHash: 'abc123',
  }, {
    runSsh: async (...args) => {
      request = args;
      return '__CODEX_CONFIG__\ndeleted=1\n';
    },
  });
  assert.deepEqual(request[2], ['~/.vscode-server/data/Machine/settings.json', 'abc123']);
});
