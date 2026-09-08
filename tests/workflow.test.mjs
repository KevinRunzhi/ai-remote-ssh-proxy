import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import net from 'node:net';
import {
  CancelledError,
  ExpectedError,
  inspectTarget,
  runProcess,
} from '../scripts/ssh.mjs';

import { sha256 } from '../scripts/config.mjs';
import { parseArgs, runCommand } from '../scripts/e2e.mjs';

const SSH_ORIGINAL = 'Host dev-linux\n  HostName example.invalid\n';
const SETTINGS_ORIGINAL = '{\n  // keep\n  "editor.tabSize": 2\n}\n';
const REMOTE_SETTINGS = '/home/test/.vscode-server/data/Machine/settings.json';

function makeIo(confirm = true) {
  const messages = [];
  return {
    io: {
      isInteractive: true,
      prompt: async () => { throw new Error('unexpected prompt'); },
      confirm: async () => confirm,
      write: (message) => messages.push(message),
    },
    messages,
  };
}

test('T5 未启动的真实本地代理使 configure 停止且不修改配置', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const harness = await makeHarness();
  try {
    harness.dependencies.inspectTarget = (options) => inspectTarget(options, {
      runProcess,
      sshEffective: async () => { throw new Error('no real SSH in this test'); },
    });
    const output = makeIo();
    assert.equal(await runCommand({ command: 'configure', options: {
      ...harness.options, localProxy: `http://127.0.0.1:${port}`,
    }, io: output.io, dependencies: harness.dependencies }), 1);
    assert.match(output.messages.join('\n'), /local-proxy.*传输失败/);
    assert.equal(await fs.readFile(harness.sshConfig, 'utf8'), SSH_ORIGINAL);
    assert.equal(harness.getRemote(), SETTINGS_ORIGINAL);
    await assert.rejects(() => fs.access(path.join(harness.stateDirectory, 'active.json')));
  } finally { await harness.cleanup(); }
});

test('T5 SSH 退出、取消或超时不写配置且不泄露原始错误', async () => {
  const cases = [
    [new ExpectedError('SSH 连接失败（退出码 255；SSH 认证未完成）；原始输出未展示。'), /退出码 255/],
    [new CancelledError('操作已取消。'), /操作已取消/],
    [new ExpectedError('SSH 检查超时；SSH 认证未完成。'), /认证未完成/],
    [new Error('TEST_TOKEN_SSH_FAILURE'), /SSH 或远端只读检查失败/],
  ];
  for (const [error, expectedMessage] of cases) {
    const harness = await makeHarness();
    try {
      harness.dependencies.inspectTarget = (options) => inspectTarget(options, {
        runProcess: async () => ({ exitCode: 0, stdout: 'http=401;connect=200;tls=0' }),
        sshEffective: async () => { throw error; },
      });
      const output = makeIo();
      assert.equal(await runCommand({ command: 'configure', options: harness.options, io: output.io, dependencies: harness.dependencies }), 1);
      const text = output.messages.join('\n');
      assert.match(text, expectedMessage);
      if (!(error instanceof CancelledError)) assert.match(text, /未修改配置/);
      assert.doesNotMatch(text, /TEST_TOKEN/);
      assert.equal(await fs.readFile(harness.sshConfig, 'utf8'), SSH_ORIGINAL);
      assert.equal(harness.getRemote(), SETTINGS_ORIGINAL);
      await assert.rejects(() => fs.access(path.join(harness.stateDirectory, 'active.json')));
    } finally { await harness.cleanup(); }
  }
});

test('T5 本地写入失败不触碰远端配置', async () => {
  const harness = await makeHarness();
  try {
    harness.dependencies.atomicLocalWrite = async () => { throw new Error('TEST_TOKEN_DISK_FULL'); };
    const output = makeIo();
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: output.io, dependencies: harness.dependencies }), 1);
    assert.equal(await fs.readFile(harness.sshConfig, 'utf8'), SSH_ORIGINAL);
    assert.equal(harness.getRemote(), SETTINGS_ORIGINAL);
    assert.doesNotMatch(output.messages.join('\n'), /TEST_TOKEN/);
  } finally { await harness.cleanup(); }
});

test('T5 重复配置无监听保留首次记录，代理故障不阻止 remove', async () => {
  const harness = await makeHarness();
  try {
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: makeIo().io, dependencies: harness.dependencies }), 0);
    const statePath = path.join(harness.stateDirectory, 'active.json');
    const record = await fs.readFile(statePath, 'utf8');
    harness.setEndpoint({ status: 'unknown', message: '入口尚未监听；请重连。' });
    const output = makeIo();
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: output.io, dependencies: harness.dependencies }), 0);
    assert.match(output.messages.join('\n'), /请重连/);
    assert.equal(await fs.readFile(statePath, 'utf8'), record);
    harness.dependencies.inspectTarget = async () => { throw new Error('proxy unavailable'); };
    harness.dependencies.checkConfiguredEndpoint = async () => { throw new Error('proxy unavailable'); };
    assert.equal(await runCommand({ command: 'remove', options: {}, io: makeIo().io, dependencies: harness.dependencies }), 0);
    assert.equal(harness.getRemote(), SETTINGS_ORIGINAL);
    assert.equal(await fs.readFile(harness.sshConfig, 'utf8'), SSH_ORIGINAL);
  } finally { await harness.cleanup(); }
});

test('T5 回复丢失后重读已写入的远端状态并安全撤销', async () => {
  const harness = await makeHarness();
  try {
    const write = harness.dependencies.writeRemoteSettings;
    let first = true;
    harness.dependencies.writeRemoteSettings = async (args) => {
      await write(args);
      if (first) { first = false; throw new Error('lost reply'); }
    };
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: makeIo().io, dependencies: harness.dependencies }), 1);
    assert.equal(harness.getRemote(), SETTINGS_ORIGINAL);
    assert.equal(await fs.readFile(harness.sshConfig, 'utf8'), SSH_ORIGINAL);
    await assert.rejects(() => fs.access(path.join(harness.stateDirectory, 'active.json')));
  } finally { await harness.cleanup(); }
});

test('T5 结果未知时报告可执行的恢复位置且不泄露无关配置', async () => {
  const harness = await makeHarness({ settingsText: '{\n  "unrelated": "TEST_TOKEN_PRIVATE"\n}\n' });
  try {
    const remoteStaging = '/home/test/.codex-proxy-stage-unknown';
    harness.dependencies.writeRemoteSettings = async ({ text, onStaging }) => {
      await onStaging(remoteStaging);
      harness.setRemote(`${text}corrupt`);
      throw new Error('TEST_TOKEN_REMOTE_UNKNOWN');
    };
    const output = makeIo();
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: output.io, dependencies: harness.dependencies }), 1);
    const text = output.messages.join('\n');
    assert.ok(text.includes(path.join(harness.stateDirectory, 'active.json')));
    assert.ok(text.includes(harness.sshConfig));
    assert.ok(text.includes(REMOTE_SETTINGS));
    assert.ok(text.includes(remoteStaging));
    assert.match(text, /remove/);
    assert.doesNotMatch(text, /TEST_TOKEN/);
    assert.doesNotMatch(await fs.readFile(path.join(harness.stateDirectory, 'active.json'), 'utf8'), /TEST_TOKEN_PRIVATE/);
  } finally { await harness.cleanup(); }
});

async function makeHarness({ sshText = SSH_ORIGINAL, settingsText = SETTINGS_ORIGINAL, listeners = [] } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-workflow-'));
  const stateDirectory = path.join(directory, 'state');
  const sshConfig = path.join(directory, 'config');
  await fs.writeFile(sshConfig, sshText);
  let remoteText = settingsText;
  let writeFailure = null;
  let endpoint = { status: 'pass', message: '配置无增量，已知回环端点及目标 HTTPS 检查通过。' };
  let verifyResult = {
    ok: true,
    checks: [
      { layer: 'local-proxy', status: 'pass', message: 'ok' },
      { layer: 'ssh', status: 'pass', message: 'ok' },
      { layer: 'remote-endpoint', status: 'pass', message: 'ok' },
      { layer: 'target-https', status: 'pass', message: 'ok' },
      { layer: 'codex-process', status: 'pass', message: 'PID 123 ok' },
    ],
  };
  let verifyInput = null;

  const remoteSnapshot = () => ({
    exists: remoteText !== null,
    text: remoteText,
    hash: remoteText === null ? 'missing' : sha256(remoteText),
    mode: '600',
  });
  const effective = async () => {
    const text = await fs.readFile(sshConfig, 'utf8');
    const match = text.match(/^\s*RemoteForward\s+(.+)$/m)?.[1];
    const normalized = match?.replace(/127\.0\.0\.1:(\d+)/g, '[127.0.0.1]:$1');
    return `hostname example.invalid\n${normalized ? `remoteforward ${normalized}\n` : ''}`;
  };
  const dependencies = {
    stateDirectory,
    restrictWindowsDirectory: async () => {},
    inspectTarget: async () => ({
      ok: true,
      checks: [
        { layer: 'local-proxy', status: 'pass', message: 'ok' },
        { layer: 'ssh', status: 'pass', message: 'ok' },
        { layer: 'remote-endpoint', status: 'pass', message: listeners.length ? 'known' : 'free' },
        { layer: 'target-https', status: 'unknown', message: 'not needed' },
      ],
      snapshot: {
        sshEffective: await effective(),
        remoteSettings: remoteSnapshot(),
        listenerTool: 'proc',
        listeners,
      },
    }),
    sshEffective: effective,
    remoteRead: async () => remoteSnapshot(),
    writeRemoteSettings: async ({ expectedHash, text, onStaging }) => {
      assert.equal(remoteSnapshot().hash, expectedHash);
      await onStaging('/home/test/.codex-proxy-stage');
      if (writeFailure === 'before') {
        await onStaging(null);
        writeFailure = null;
        throw new Error('TEST_TOKEN_REMOTE_FAILURE');
      }
      if (writeFailure === 'unknown') {
        remoteText = `${text}corrupt`;
        await onStaging(null);
        writeFailure = null;
        throw new Error('TEST_TOKEN_REMOTE_UNKNOWN');
      }
      remoteText = text;
      await onStaging(null);
    },
    deleteRemoteSettings: async ({ expectedHash }) => {
      assert.equal(remoteSnapshot().hash, expectedHash);
      remoteText = null;
    },
    checkConfiguredEndpoint: async () => endpoint,
    verifyTarget: async (...args) => {
      verifyInput = args;
      return verifyResult;
    },
  };
  const options = {
    host: 'dev-linux',
    localProxy: 'http://127.0.0.1:7890',
    remotePort: 17890,
    sshConfig,
    remoteSettings: REMOTE_SETTINGS,
  };
  return {
    directory, stateDirectory, sshConfig, options, dependencies,
    getRemote: () => remoteText,
    setRemote: (value) => { remoteText = value; },
    setWriteFailure: (value) => { writeFailure = value; },
    setEndpoint: (value) => { endpoint = value; },
    setVerifyResult: (value) => { verifyResult = value; },
    getVerifyInput: () => verifyInput,
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  };
}

test('拒绝确认和依赖检查失败时不写配置或恢复记录', async () => {
  const harness = await makeHarness();
  try {
    const rejected = makeIo(false);
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: rejected.io, dependencies: harness.dependencies }), 0);
    assert.equal(await fs.readFile(harness.sshConfig, 'utf8'), SSH_ORIGINAL);
    assert.equal(harness.getRemote(), SETTINGS_ORIGINAL);
    await assert.rejects(() => fs.access(path.join(harness.stateDirectory, 'active.json')));

    const failed = makeIo(true);
    harness.dependencies.inspectTarget = async () => ({
      ok: false,
      checks: [{ layer: 'local-proxy', status: 'fail', message: '代理未启动' }],
      snapshot: {},
    });
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: failed.io, dependencies: harness.dependencies }), 1);
    assert.equal(await fs.readFile(harness.sshConfig, 'utf8'), SSH_ORIGINAL);
    assert.equal(harness.getRemote(), SETTINGS_ORIGINAL);
    await assert.rejects(() => fs.access(path.join(harness.stateDirectory, 'active.json')));
  } finally { await harness.cleanup(); }
});

test('configure、重复 configure 与 remove 形成精确闭环', async () => {
  const harness = await makeHarness();
  try {
    const configured = makeIo(true);
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: configured.io, dependencies: harness.dependencies }), 0);
    assert.match(await fs.readFile(harness.sshConfig, 'utf8'), /RemoteForward 127\.0\.0\.1:17890 127\.0\.0\.1:7890/);
    assert.match(harness.getRemote(), /http:\/\/127\.0\.0\.1:17890/);
    assert.match(configured.messages.join('\n'), /需要重连/);
    const statePath = path.join(harness.stateDirectory, 'active.json');
    const firstRecord = await fs.readFile(statePath, 'utf8');
    assert.doesNotMatch(firstRecord, /example\.invalid|editor\.tabSize/);

    const repeated = makeIo(true);
    const repeatedOptions = { ...harness.options, localProxy: 'http://localhost:7890/' };
    assert.equal(await runCommand({ command: 'configure', options: repeatedOptions, io: repeated.io, dependencies: harness.dependencies }), 0);
    assert.equal(await fs.readFile(statePath, 'utf8'), firstRecord);
    assert.match(repeated.messages.join('\n'), /检查通过/);

    const removed = makeIo(true);
    assert.equal(await runCommand({ command: 'remove', options: { host: 'dev-linux' }, io: removed.io, dependencies: harness.dependencies }), 0);
    assert.equal(await fs.readFile(harness.sshConfig, 'utf8'), SSH_ORIGINAL);
    assert.equal(harness.getRemote(), SETTINGS_ORIGINAL);
    await assert.rejects(() => fs.access(statePath));
  } finally { await harness.cleanup(); }
});

test('已有活动记录阻止另一目标，端点失败不会改写首次记录', async () => {
  const harness = await makeHarness();
  try {
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: makeIo().io, dependencies: harness.dependencies }), 0);
    const statePath = path.join(harness.stateDirectory, 'active.json');
    const record = await fs.readFile(statePath, 'utf8');
    const other = makeIo();
    assert.equal(await runCommand({ command: 'configure', options: { ...harness.options, host: 'other-host' }, io: other.io, dependencies: harness.dependencies }), 1);
    harness.setEndpoint({ status: 'fail', message: '来源不明占用' });
    const failed = makeIo();
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: failed.io, dependencies: harness.dependencies }), 1);
    assert.equal(await fs.readFile(statePath, 'utf8'), record);
  } finally { await harness.cleanup(); }
});

test('首次配置发现来源不明的端口占用时停止', async () => {
  const harness = await makeHarness({ listeners: ['127.0.0.1:17890'] });
  try {
    const output = makeIo();
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: output.io, dependencies: harness.dependencies }), 1);
    assert.equal(await fs.readFile(harness.sshConfig, 'utf8'), SSH_ORIGINAL);
    assert.equal(harness.getRemote(), SETTINGS_ORIGINAL);
    await assert.rejects(() => fs.access(path.join(harness.stateDirectory, 'active.json')));
    assert.match(output.messages.join('\n'), /首次新增要求远端端口/);
  } finally { await harness.cleanup(); }
});

test('独占操作锁阻止并发写入且不删除其他进程的锁', async () => {
  const harness = await makeHarness();
  try {
    await fs.mkdir(harness.stateDirectory, { recursive: true });
    const lockPath = path.join(harness.stateDirectory, 'operation.lock');
    await fs.writeFile(lockPath, 'other-process\n');
    const output = makeIo();
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: output.io, dependencies: harness.dependencies }), 1);
    assert.equal(await fs.readFile(lockPath, 'utf8'), 'other-process\n');
    assert.equal(await fs.readFile(harness.sshConfig, 'utf8'), SSH_ORIGINAL);
    assert.equal(harness.getRemote(), SETTINGS_ORIGINAL);
    assert.match(output.messages.join('\n'), /另一个配置或移除操作/);
    assert.match(output.messages.join('\n'), /确认没有命令运行.*operation\.lock/);
  } finally { await harness.cleanup(); }
});

test('远端写入失败恢复本地；结果未知时保留记录但仍撤销本地转发', async () => {
  const before = await makeHarness();
  try {
    before.setWriteFailure('before');
    const output = makeIo();
    assert.equal(await runCommand({ command: 'configure', options: before.options, io: output.io, dependencies: before.dependencies }), 1);
    assert.equal(await fs.readFile(before.sshConfig, 'utf8'), SSH_ORIGINAL);
    assert.equal(before.getRemote(), SETTINGS_ORIGINAL);
    await assert.rejects(() => fs.access(path.join(before.stateDirectory, 'active.json')));
    assert.doesNotMatch(output.messages.join('\n'), /TEST_TOKEN/);
  } finally { await before.cleanup(); }

  const unknown = await makeHarness();
  try {
    unknown.setWriteFailure('unknown');
    const output = makeIo();
    assert.equal(await runCommand({ command: 'configure', options: unknown.options, io: output.io, dependencies: unknown.dependencies }), 1);
    assert.equal(await fs.readFile(unknown.sshConfig, 'utf8'), SSH_ORIGINAL);
    await fs.access(path.join(unknown.stateDirectory, 'active.json'));
    assert.match(output.messages.join('\n'), /需要恢复/);
    assert.doesNotMatch(output.messages.join('\n'), /TEST_TOKEN/);
  } finally { await unknown.cleanup(); }
});

test('等价用户配置不取得所有权，remove 保留原文', async () => {
  const ssh = 'Host dev-linux\n  RemoteForward 127.0.0.1:17890 127.0.0.1:7890\n';
  const settings = '{\n  "http.useLocalProxyConfiguration": false,\n  "http.proxy": "http://127.0.0.1:17890"\n}\n';
  const harness = await makeHarness({ sshText: ssh, settingsText: settings });
  try {
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: makeIo().io, dependencies: harness.dependencies }), 0);
    const record = JSON.parse(await fs.readFile(path.join(harness.stateDirectory, 'active.json'), 'utf8'));
    assert.equal(record.recovery.ssh.owned, false);
    assert.equal(record.recovery.settings.owned, false);
    assert.equal(await runCommand({ command: 'remove', options: {}, io: makeIo().io, dependencies: harness.dependencies }), 0);
    assert.equal(await fs.readFile(harness.sshConfig, 'utf8'), ssh);
    assert.equal(harness.getRemote(), settings);
  } finally { await harness.cleanup(); }
});

test('首次创建的 Remote settings 在 remove 时删除', async () => {
  const harness = await makeHarness({ settingsText: null });
  try {
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: makeIo().io, dependencies: harness.dependencies }), 0);
    assert.notEqual(harness.getRemote(), null);
    assert.equal(await runCommand({ command: 'remove', options: {}, io: makeIo().io, dependencies: harness.dependencies }), 0);
    assert.equal(harness.getRemote(), null);
  } finally { await harness.cleanup(); }
});

test('remove 可读取 T0 旧版恢复记录', async () => {
  const harness = await makeHarness();
  try {
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: makeIo().io, dependencies: harness.dependencies }), 0);
    const statePath = path.join(harness.stateDirectory, 'active.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    const legacy = {
      version: 1,
      host: state.host,
      sshConfig: state.sshConfig,
      remoteSettings: state.remoteSettings,
      localProxy: state.localProxy,
      remotePort: state.remotePort,
      localOwned: state.recovery.ssh.owned,
      localSnippet: state.recovery.ssh.snippet,
      localBeforeHash: state.recovery.ssh.beforeHash,
      localAfterHash: state.recovery.ssh.afterHash,
      remoteOwned: state.recovery.settings.owned,
      remoteExisted: state.recovery.settings.existed,
      remoteMode: state.remoteMode,
      remoteBeforeHash: state.recovery.settings.beforeHash,
      remoteAfterHash: state.recovery.settings.afterHash,
      remoteInverseSteps: state.recovery.settings.inverseSteps,
      listenerTool: state.listenerTool,
      remoteStaging: null,
    };
    await fs.writeFile(statePath, `${JSON.stringify(legacy, null, 2)}\n`);
    assert.equal(await runCommand({ command: 'remove', options: {}, io: makeIo().io, dependencies: harness.dependencies }), 0);
    assert.equal(await fs.readFile(harness.sshConfig, 'utf8'), SSH_ORIGINAL);
    assert.equal(harness.getRemote(), SETTINGS_ORIGINAL);
  } finally { await harness.cleanup(); }
});

test('remove 在用户后续修改后停止并保留记录', async () => {
  const harness = await makeHarness();
  try {
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: makeIo().io, dependencies: harness.dependencies }), 0);
    await fs.appendFile(harness.sshConfig, '# user change\n');
    const output = makeIo();
    assert.equal(await runCommand({ command: 'remove', options: {}, io: output.io, dependencies: harness.dependencies }), 1);
    await fs.access(path.join(harness.stateDirectory, 'active.json'));
    assert.match(await fs.readFile(harness.sshConfig, 'utf8'), /user change/);
    assert.match(output.messages.join('\n'), /保留用户修改/);
  } finally { await harness.cleanup(); }
});

test('参数严格校验并归一 localhost', () => {
  const parsed = parseArgs(['configure', '--host', 'dev-linux', '--local-proxy', 'http://localhost:7890/', '--remote-port', '17891', '--remote-settings', '/home/test/settings.json']);
  assert.equal(parsed.host, 'dev-linux');
  assert.equal(parsed.remotePort, '17891');
  assert.throws(() => parseArgs(['configure', '--yes', 'true']), /无法识别/);
  assert.throws(() => parseArgs(['remove', '--remote-port', '17890']), /无法识别/);
  assert.throws(() => parseArgs(['configure', '--ssh-config', 'relative']), /绝对路径/);
});

test('非交互缺参和未知错误不会泄露原始 Token', async () => {
  const harness = await makeHarness();
  try {
    const nonInteractive = { ...makeIo().io, isInteractive: false };
    assert.equal(await runCommand({ command: 'configure', options: { sshConfig: harness.sshConfig }, io: nonInteractive, dependencies: harness.dependencies }), 1);
    harness.dependencies.inspectTarget = async () => { throw new Error('TEST_TOKEN_SHOULD_NOT_LEAK'); };
    const output = makeIo();
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: output.io, dependencies: harness.dependencies }), 1);
    assert.doesNotMatch(output.messages.join('\n'), /TEST_TOKEN_SHOULD_NOT_LEAK/);
  } finally { await harness.cleanup(); }
});

test('verify 复用记录且不修改配置、Remote settings 或恢复记录', async () => {
  const harness = await makeHarness();
  try {
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: makeIo().io, dependencies: harness.dependencies }), 0);
    const statePath = path.join(harness.stateDirectory, 'active.json');
    const before = {
      ssh: await fs.readFile(harness.sshConfig),
      remote: harness.getRemote(),
      state: await fs.readFile(statePath),
    };

    const output = makeIo();
    assert.equal(await runCommand({
      command: 'verify',
      options: { host: 'dev-linux', sshConfig: harness.sshConfig, pid: 456 },
      io: output.io,
      dependencies: harness.dependencies,
    }), 0);
    assert.deepEqual(await fs.readFile(harness.sshConfig), before.ssh);
    assert.equal(harness.getRemote(), before.remote);
    assert.deepEqual(await fs.readFile(statePath), before.state);
    assert.deepEqual(harness.getVerifyInput(), [
      {
        host: 'dev-linux',
        sshConfig: harness.sshConfig,
        remoteSettings: REMOTE_SETTINGS,
        pid: 456,
        targetUrl: 'https://api.openai.com/v1/models',
      },
      { localProxy: 'http://127.0.0.1:7890', localPort: 7890, remotePort: 17890, listenerTool: 'proc' },
    ]);
    assert.match(output.messages.join('\n'), /codex-process：PID 123 ok/);
  } finally { await harness.cleanup(); }
});

test('verify 进程证据不足时返回 1 并展示 unknown', async () => {
  const harness = await makeHarness();
  try {
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: makeIo().io, dependencies: harness.dependencies }), 0);
    harness.setVerifyResult({
      ok: false,
      checks: [
        { layer: 'local-proxy', status: 'pass', message: 'ok' },
        { layer: 'ssh', status: 'pass', message: 'ok' },
        { layer: 'remote-endpoint', status: 'pass', message: 'ok' },
        { layer: 'target-https', status: 'pass', message: 'ok' },
        { layer: 'codex-process', status: 'unknown', message: '未找到进程' },
      ],
    });
    const output = makeIo();
    assert.equal(await runCommand({ command: 'verify', options: { host: 'dev-linux', sshConfig: harness.sshConfig }, io: output.io, dependencies: harness.dependencies }), 1);
    assert.match(output.messages.join('\n'), /ℹ️ codex-process：未找到进程/);
    assert.match(output.messages.join('\n'), /验证证据不足/);
  } finally { await harness.cleanup(); }
});

test('T5 只有同时段代理日志时仍要求目标进程关联证据', async () => {
  const harness = await makeHarness();
  try {
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: makeIo().io, dependencies: harness.dependencies }), 0);
    const output = makeIo();
    assert.equal(await runCommand({
      command: 'verify',
      options: { host: 'dev-linux', sshConfig: harness.sshConfig },
      io: output.io,
      dependencies: harness.dependencies,
    }), 0);
    const text = output.messages.join('\n');
    assert.match(text, /仍需人工请求及目标进程到代理端口的关联证据/);
    assert.doesNotMatch(text, /M1.*通过|验收完成/);
  } finally { await harness.cleanup(); }
});

test('T5 Remote settings 被用户修改后 remove 停止并保留内容', async () => {
  const harness = await makeHarness();
  try {
    assert.equal(await runCommand({ command: 'configure', options: harness.options, io: makeIo().io, dependencies: harness.dependencies }), 0);
    harness.setRemote(`${harness.getRemote()}// user change\n`);
    const output = makeIo();
    assert.equal(await runCommand({ command: 'remove', options: {}, io: output.io, dependencies: harness.dependencies }), 1);
    assert.match(harness.getRemote(), /user change/);
    await fs.access(path.join(harness.stateDirectory, 'active.json'));
    assert.match(output.messages.join('\n'), /保留用户修改/);
  } finally { await harness.cleanup(); }
});
