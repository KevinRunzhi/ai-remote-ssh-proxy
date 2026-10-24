import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectCodeInstallation, detectLocalTools, locateRemoteServer, serverPreparationInstructions, inspectRemoteSshSettings } from '../scripts/vscode.mjs';

const commit = '6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1';
test('官方安装器普通与版本子目录布局均可核对，不执行 cmd 文本', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-vscode-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'Code.exe'); await fs.writeFile(executable, 'fixture');
  await fs.mkdir(path.join(root, 'bin'));
  for (const prefix of ['', '6d62b1d5da\\']) {
    const app = path.join(root, ...prefix.split('\\').filter(Boolean), 'resources', 'app');
    await fs.mkdir(path.join(app, 'out'), { recursive: true });
    await fs.writeFile(path.join(app, 'out', 'cli.js'), 'fixture');
    await fs.writeFile(path.join(app, 'product.json'), JSON.stringify({ applicationName: 'code', quality: 'stable', commit }));
    await fs.writeFile(path.join(app, 'package.json'), '{"version":"1.142.0"}');
    await fs.writeFile(path.join(root, 'bin', 'code.cmd'), `@echo off\r\n"%~dp0..\\Code.exe" "%~dp0..\\${prefix}resources\\app\\out\\cli.js" %*\r\n`);
    assert.equal((await inspectCodeInstallation(executable)).commit, commit);
  }
  await fs.writeFile(path.join(root, 'bin', 'code.cmd'), 'arbitrary-command TEST_SECRET');
  await assert.rejects(inspectCodeInstallation(executable), (error) => !error.message.includes('TEST_SECRET'));
});

test('检测精确 CLI/扩展版本；架构或更新不一致停止，缺软件给官方入口', async () => {
  const installation = { codePath: path.resolve('Code.exe'), cliPath: path.resolve('cli.js'), commit, version: '1.142.0' };
  const execute = async ({ args, env }) => {
    if (args.includes('--version') && args[0] === installation.cliPath) {
      assert.equal(env.ELECTRON_RUN_AS_NODE, '1'); return { exitCode: 0, stdout: `1.142.0\n${commit}\nx64\n`, stderr: '' };
    }
    if (args.includes('--list-extensions')) return { exitCode: 0, stdout: 'ms-vscode-remote.remote-ssh@0.128.0\n', stderr: '' };
    return { exitCode: 0, stdout: args[0] === '-V' ? '' : 'curl 8.21.0\n', stderr: args[0] === '-V' ? 'OpenSSH_for_Windows_9.5p2\n' : '' };
  };
  const args = { codePath: installation.codePath, sshConfig: path.resolve('config') };
  const result = await detectLocalTools(args, { inspectCodeInstallation: async () => installation, runProcess: execute, inspectRemoteSshSettings: async () => ({ ready: true }) });
  assert.equal(result.ready, true); assert.equal(result.remoteSshVersion, '0.128.0');
  await assert.rejects(detectLocalTools(args, { inspectCodeInstallation: async () => installation,
    runProcess: async () => ({ exitCode: 0, stdout: `1.142.0\n${commit}\narm64\n`, stderr: '' }) }), /版本\/架构/);
  const missing = await detectLocalTools({}, { inspectCodeInstallation: async () => { const error = new Error(); error.code = 'ENOENT'; throw error; } });
  assert.equal(missing.ready, false); assert.match(missing.guides.vscode, /^https:\/\/code.visualstudio.com\//);
});

test('核对 VS Code 默认配置入口，不读取或返回无关设置，重复/自定义入口停止', async () => {
  const sshConfig = path.join(os.homedir(), '.ssh', 'config'), sshPath = path.resolve('ssh.exe');
  const inspect = (text) => inspectRemoteSshSettings({ sshConfig, sshPath, settingsPath: path.resolve('settings.json') }, { readLocalConfig: async () => ({ text }) });
  assert.equal((await inspect(null)).ready, true);
  assert.equal((await inspect('{"unrelated":"TEST_SECRET"}')).ready, true);
  const changed = await inspect(JSON.stringify({ 'remote.SSH.configFile': path.resolve('other-config'), unrelated: 'TEST_SECRET' }));
  assert.deepEqual(changed.issues, ['ssh-config-entry']); assert.ok(!JSON.stringify(changed).includes('TEST_SECRET'));
  await assert.rejects(inspect('{"remote.SSH.path":"a","remote.SSH.path":"b"}'), /重复/);
  assert.deepEqual((await inspect('{"remote.SSH.serverInstallPath":{"sample":"/other"}}')).issues, ['server-install-path']);
});

test('实际 Server 证据缺失、多候选、非标准目录均不猜 settings', async () => {
  const signal = new AbortController().signal;
  for (const status of ['missing', 'ambiguous', 'nonstandard']) {
    const result = await locateRemoteServer({ signal }, { home: '/root', commit }, { runSsh: async (options) => {
      assert.equal(options.signal, signal); return `__CODEX_SERVER_V1__\nstatus=${status}\n`;
    } });
    assert.equal(result.status, status); assert.equal(result.settingsPath, null);
  }
  const settingsPath = '/root/.vscode-server/data/Machine/settings.json';
  const output = `__CODEX_SERVER_V1__\nstatus=ready\npid=123\ncommit=${commit}\nsettings=${Buffer.from(settingsPath).toString('base64')}\n`;
  assert.equal((await locateRemoteServer({}, { home: '/root', commit }, { runSsh: async () => output })).settingsPath, settingsPath);
  await assert.rejects(locateRemoteServer({}, { home: '/other', commit }, { runSsh: async () => output }), /路径/);
  await assert.rejects(locateRemoteServer({}, { home: '/root', commit }, { runSsh: async () => output + 'TEST_SECRET' }), (error) => !error.message.includes('TEST_SECRET'));
});

test('首次准备只给官方连接/下载步骤，不将点击视为安装或修改全局下载设置', () => {
  const result = serverPreparationInstructions({ alias: 'sample', sshConfig: path.resolve('config'), remoteSshVersion: '0.128.0' });
  assert.ok(result.steps.some((text) => text.includes('不代表安装成功')));
  assert.deepEqual(result.choices, ['ready', 'later']);
  assert.ok(result.download.serverDomains.includes('update.code.visualstudio.com'));
  assert.match(result.download.policy, /不修改/);
});
