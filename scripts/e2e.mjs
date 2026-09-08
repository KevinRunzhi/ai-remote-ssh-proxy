#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import {
  ConfigError,
  atomicLocalWrite,
  deleteRemoteSettings,
  prepareEdits,
  restoreSettingsEdit,
  restoreSshEdit,
  restrictWindowsDirectory,
  saveRecoveryRecord,
  sha256,
  writeRemoteSettings,
} from './config.mjs';
import {
  CancelledError,
  ExpectedError,
  checkConfiguredEndpoint,
  inspectTarget,
  preflightRemote,
  probeLocalProxy,
  probeRemoteTarget,
  remoteListeners,
  remoteRead,
  runProcess,
  runScp,
  runSsh,
  sshEffective,
  verifyTarget,
} from './ssh.mjs';

const STATE_VERSION = 2;
const DEFAULT_REMOTE_PORT = 17890;
const TARGET_URL = 'https://api.openai.com/v1/models';
const STATE_DIRECTORY_NAME = 'codex-remote-ssh-proxy-e2e';

function fail(message) {
  throw new ExpectedError(message);
}

function defaultSshConfig() {
  return path.join(os.homedir(), '.ssh', 'config');
}

function statePaths(dependencies) {
  const directory = dependencies.stateDirectory
    ?? (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, STATE_DIRECTORY_NAME));
  if (!directory) fail('LOCALAPPDATA 不存在，无法保存恢复信息。');
  return { directory, active: path.join(directory, 'active.json'), lock: path.join(directory, 'operation.lock') };
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail(`${name} 必须是 1024–65535 的整数。`);
  return port;
}

function normalizeProxy(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('本地代理必须是 http://127.0.0.1:端口 或 http://localhost:端口。');
  }
  if (
    parsed.protocol !== 'http:'
    || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
    || !parsed.port
    || parsed.username
    || parsed.password
    || !['', '/'].includes(parsed.pathname)
    || parsed.search
    || parsed.hash
  ) fail('本地代理必须是无认证、无路径的回环 HTTP 代理。');
  const localPort = parsePort(parsed.port, '本地代理端口');
  return { localProxy: `http://127.0.0.1:${localPort}`, localPort };
}

function assertHost(host) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(host ?? '')) fail('SSH Host alias 格式不合法。');
}

function assertRemoteSettings(remoteSettings) {
  if (typeof remoteSettings !== 'string' || !remoteSettings.startsWith('/') || /[\0\r\n]/.test(remoteSettings)) {
    fail('Remote settings 必须是已确认的 Linux 绝对路径。');
  }
}

export function parseArgs(argv) {
  const command = argv[0];
  if (!['configure', 'verify', 'remove'].includes(command)) {
    fail('用法：node scripts/e2e.mjs <configure|verify|remove> [--host alias] [--local-proxy URL] [--remote-port port] [--ssh-config path] [--remote-settings path] [--pid number]');
  }
  const allowed = new Set(['--host', '--ssh-config', '--remote-settings']);
  if (command === 'configure') {
    allowed.add('--local-proxy');
    allowed.add('--remote-port');
  }
  if (command === 'verify') allowed.add('--pid');
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || value === undefined) fail(`无法识别的参数：${key ?? '(空)'}`);
    if (values[key] !== undefined) fail(`参数重复：${key}`);
    values[key] = value;
  }
  if (values['--ssh-config'] !== undefined && !path.isAbsolute(values['--ssh-config'])) fail('--ssh-config 必须是绝对路径。');
  const pid = values['--pid'] === undefined ? undefined : Number(values['--pid']);
  if (pid !== undefined && (!Number.isInteger(pid) || pid < 1)) fail('--pid 必须是正整数。');
  return {
    host: values['--host'],
    localProxy: values['--local-proxy'],
    remotePort: values['--remote-port'],
    sshConfig: values['--ssh-config'] === undefined ? defaultSshConfig() : path.resolve(values['--ssh-config']),
    remoteSettings: values['--remote-settings'],
    pid,
    explicit: {
      host: values['--host'] !== undefined,
      localProxy: values['--local-proxy'] !== undefined,
      remotePort: values['--remote-port'] !== undefined,
      sshConfig: values['--ssh-config'] !== undefined,
      remoteSettings: values['--remote-settings'] !== undefined,
    },
  };
}

function defaultIo() {
  const ask = async (question) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return (await rl.question(question)).trim(); } finally { rl.close(); }
  };
  return {
    isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt: (question) => ask(`${question}：`),
    confirm: async (question) => (await ask(`${question}，输入 yes 继续：`)).toLowerCase() === 'yes',
    write: (message) => console.log(message),
  };
}

function operations(dependencies) {
  return {
    fs, runProcess, runSsh, runScp, inspectTarget, checkConfiguredEndpoint, sshEffective,
    remoteRead, remoteListeners, preflightRemote, probeLocalProxy, probeRemoteTarget,
    verifyTarget,
    prepareEdits, atomicLocalWrite, saveRecoveryRecord, restrictWindowsDirectory,
    writeRemoteSettings, deleteRemoteSettings, restoreSshEdit, restoreSettingsEdit,
    ...dependencies,
  };
}

async function readState(paths, ops, required = true) {
  try {
    const stat = await ops.fs.lstat(paths.active);
    if (stat.isSymbolicLink() || !stat.isFile()) fail('恢复记录不是普通文件。');
    const state = JSON.parse(await ops.fs.readFile(paths.active, 'utf8'));
    if (state.version === STATE_VERSION && state.recovery) return state;
    if (state.version === 1 && state.localBeforeHash && state.remoteBeforeHash) {
      const proxy = normalizeProxy(state.localProxy);
      return {
        version: STATE_VERSION,
        host: state.host,
        localProxy: proxy.localProxy,
        localPort: proxy.localPort,
        remotePort: state.remotePort,
        sshConfig: path.resolve(state.sshConfig),
        remoteSettings: state.remoteSettings,
        remoteMode: state.remoteMode,
        listenerTool: state.listenerTool,
        phase: 'applied',
        remoteStaging: state.remoteStaging ?? null,
        recovery: {
          ssh: {
            owned: state.localOwned,
            snippet: state.localSnippet,
            beforeHash: state.localBeforeHash,
            afterHash: state.localAfterHash,
          },
          settings: {
            owned: state.remoteOwned,
            existed: state.remoteExisted,
            properties: {},
            inverseSteps: state.remoteInverseSteps,
            beforeHash: state.remoteBeforeHash,
            afterHash: state.remoteAfterHash,
          },
        },
      };
    }
    fail('恢复记录版本不受支持。');
  } catch (error) {
    if (error.code === 'ENOENT' && !required) return null;
    if (error.code === 'ENOENT') fail('没有本次配置记录。');
    if (error instanceof SyntaxError) fail('恢复记录损坏，停止操作。');
    throw error;
  }
}

async function restrictDirectory(paths, ops) {
  await ops.fs.mkdir(paths.directory, { recursive: true });
  await ops.restrictWindowsDirectory(paths.directory, { runProcess: ops.runProcess });
}

async function writeState(paths, state, ops) {
  const current = await ops.fs.readFile(paths.active, 'utf8');
  await ops.atomicLocalWrite({ filePath: paths.active, expectedHash: sha256(current), text: `${JSON.stringify(state, null, 2)}\n` });
}

async function createState(paths, state, ops) {
  await ops.saveRecoveryRecord({ directory: paths.directory, record: state }, {
    fs: ops.fs,
    restrictDirectory: () => ops.restrictWindowsDirectory(paths.directory, { runProcess: ops.runProcess }),
  });
}

async function deleteState(paths, ops) { await ops.fs.unlink(paths.active); }

async function withOperationLock(paths, ops, action) {
  await restrictDirectory(paths, ops);
  let handle;
  let created = false;
  try {
    handle = await ops.fs.open(paths.lock, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    created = true;
    await handle.writeFile(`${process.pid}\n`, 'utf8');
    await handle.close();
    handle = null;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await ops.fs.rm(paths.lock, { force: true }).catch(() => {});
    if (error.code === 'EEXIST') {
      fail(`另一个配置或移除操作正在进行；未修改配置。若确认没有命令运行，请手动删除残留锁：${paths.lock}`);
    }
    throw error;
  }
  try { return await action(); } finally { await ops.fs.rm(paths.lock, { force: true }).catch(() => {}); }
}

async function regularFileText(filePath, ops) {
  let stat;
  try { stat = await ops.fs.lstat(filePath); } catch (error) {
    if (error.code === 'ENOENT') fail(`文件不存在：${filePath}`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`拒绝处理链接或非普通文件：${filePath}`);
  return ops.fs.readFile(filePath, 'utf8');
}

async function requirePrompt(io, label) {
  if (!io.isInteractive) fail(`非交互环境缺少 ${label}；请在 PowerShell 中运行并补齐参数。`);
  return io.prompt(label);
}

async function resolveNewConfigureOptions(input, io) {
  const host = input.host ?? await requirePrompt(io, 'SSH Host alias');
  const localProxyInput = input.localProxy ?? await requirePrompt(io, '本地代理（例如 http://127.0.0.1:7890）');
  const remoteSettings = input.remoteSettings ?? await requirePrompt(io, 'Remote settings 的 Linux 绝对路径');
  assertHost(host);
  assertRemoteSettings(remoteSettings);
  const proxy = normalizeProxy(localProxyInput);
  return {
    ...input, host, ...proxy,
    remotePort: input.remotePort === undefined ? DEFAULT_REMOTE_PORT : parsePort(input.remotePort, '远端端口'),
    sshConfig: path.resolve(input.sshConfig ?? defaultSshConfig()), remoteSettings,
  };
}

function resolveRecordedOptions(input, state) {
  const explicit = input.explicit ?? Object.fromEntries(['host', 'localProxy', 'remotePort', 'sshConfig', 'remoteSettings'].map((key) => [key, input[key] !== undefined]));
  for (const key of ['host', 'localProxy', 'remotePort', 'sshConfig', 'remoteSettings']) {
    if (!explicit[key]) continue;
    const supplied = key === 'sshConfig' ? path.resolve(input[key]) : input[key];
    const normalized = key === 'localProxy' ? normalizeProxy(supplied).localProxy
      : key === 'remotePort' ? parsePort(supplied, '远端端口') : supplied;
    if (normalized !== state[key]) fail(`${key} 与本次恢复记录不符。`);
  }
  return { ...input, ...state, explicit };
}

function printChecks(result, io) {
  const icons = { pass: '✅', fail: '❌', unknown: 'ℹ️' };
  for (const check of result.checks) io.write(`${icons[check.status]} ${check.layer}：${check.message}`);
}

function assertOnlyExpectedForwardAdded(before, after, remotePort, localPort) {
  const beforeLines = before.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const afterLines = after.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const normalizeEndpoint = (value) => value.replace(/^\[([^\]]+)]:(\d+)$/, '$1:$2');
  const index = afterLines.findIndex((line) => {
    const [keyword, listen, destination, extra] = line.trim().split(/\s+/);
    return keyword === 'remoteforward'
      && extra === undefined
      && normalizeEndpoint(listen) === `127.0.0.1:${remotePort}`
      && normalizeEndpoint(destination) === `127.0.0.1:${localPort}`;
  });
  if (index < 0) fail('ssh -G 未确认预期的 RemoteForward。');
  afterLines.splice(index, 1);
  if (beforeLines.join('\n') !== afterLines.join('\n')) fail('ssh -G 显示除预期 RemoteForward 外还有其他有效配置变化。');
}

function assertNoPendingStaging(state) {
  if (state.remoteStaging) fail(`上次远端暂存清理结果不明；请先人工核对：${state.remoteStaging}`);
}

async function readCurrent(state, ops) {
  const sshText = await regularFileText(state.sshConfig, ops);
  const remote = await ops.remoteRead({ host: state.host, sshConfig: state.sshConfig }, state.remoteSettings);
  return { sshText, remote };
}

function assertAppliedOrOriginal(state, current) {
  if (![state.recovery.ssh.beforeHash, state.recovery.ssh.afterHash].includes(sha256(current.sshText))) {
    fail('当前 SSH config 摘要与修改前后状态都不符；停止并保留用户修改。');
  }
  if (![state.recovery.settings.beforeHash, state.recovery.settings.afterHash].includes(current.remote.hash)) {
    fail('当前 Remote settings 摘要与修改前后状态都不符；停止并保留用户修改。');
  }
}

async function updatePhase(paths, state, phase, ops) { state.phase = phase; await writeState(paths, state, ops); }

function stagingTracker(paths, state, ops) {
  return async (remoteStaging) => { state.remoteStaging = remoteStaging; await writeState(paths, state, ops); };
}

function recoveryInstructions(paths, state, message) {
  const locations = [
    `恢复记录：${paths.active}`,
    `SSH config：${state.sshConfig}`,
    `Remote settings：${state.remoteSettings}`,
  ];
  if (state.remoteStaging) locations.push(`远端暂存：${state.remoteStaging}`);
  locations.push(`下一步：保留恢复记录，核对以上位置后运行 node scripts/e2e.mjs remove --host ${state.host}。`);
  return `${message}\n${locations.join('\n')}`;
}

async function writeRemote(state, text, expectedHash, paths, ops) {
  await ops.writeRemoteSettings({
    options: { host: state.host, sshConfig: state.sshConfig }, remotePath: state.remoteSettings,
    expectedHash, text, mode: state.remoteMode, temporaryDirectory: paths.directory,
    onStaging: stagingTracker(paths, state, ops),
  }, {
    fs: ops.fs, runSsh: ops.runSsh, runScp: ops.runScp,
    restrictDirectory: () => ops.restrictWindowsDirectory(paths.directory, { runProcess: ops.runProcess }),
  });
}

async function restoreState(paths, state, ops) {
  let remoteSafe = !state.remoteStaging;
  const settingsRecovery = state.recovery.settings;
  if (remoteSafe) {
    try {
      const remote = await ops.remoteRead({ host: state.host, sshConfig: state.sshConfig }, state.remoteSettings);
      if (![settingsRecovery.beforeHash, settingsRecovery.afterHash].includes(remote.hash)) {
        remoteSafe = false;
      } else if (settingsRecovery.owned && remote.hash === settingsRecovery.afterHash) {
        const restored = ops.restoreSettingsEdit({ settingsText: remote.text, recovery: settingsRecovery });
        if (restored === null) {
          await ops.deleteRemoteSettings({
            options: { host: state.host, sshConfig: state.sshConfig }, remotePath: state.remoteSettings,
            expectedHash: settingsRecovery.afterHash,
          }, { runSsh: ops.runSsh });
        } else {
          await writeRemote(state, restored, settingsRecovery.afterHash, paths, ops);
        }
      }
    } catch { remoteSafe = false; }
  }

  let localSafe = true;
  const sshRecovery = state.recovery.ssh;
  try {
    const sshText = await regularFileText(state.sshConfig, ops);
    const sshHash = sha256(sshText);
    if (![sshRecovery.beforeHash, sshRecovery.afterHash].includes(sshHash)) {
      localSafe = false;
    } else if (sshRecovery.owned && sshHash === sshRecovery.afterHash) {
      const restored = ops.restoreSshEdit({ sshText, recovery: sshRecovery });
      await ops.atomicLocalWrite({ filePath: state.sshConfig, expectedHash: sshRecovery.afterHash, text: restored });
    }
  } catch { localSafe = false; }

  if (!remoteSafe || !localSafe) return false;
  try {
    const current = await readCurrent(state, ops);
    return sha256(current.sshText) === sshRecovery.beforeHash && current.remote.hash === settingsRecovery.beforeHash;
  } catch { return false; }
}

async function configureNew(options, io, paths, ops) {
  const sshText = await regularFileText(options.sshConfig, ops);
  const inspected = await ops.inspectTarget({ ...options, targetUrl: TARGET_URL });
  printChecks(inspected, io);
  if (!inspected.ok) fail('前置检查未通过，未修改配置。');
  const remote = inspected.snapshot.remoteSettings;
  if (!remote) fail('未取得 Remote settings 快照，未修改配置。');
  const prepared = ops.prepareEdits({ sshText, settingsText: remote.text, host: options.host, localPort: options.localPort, remotePort: options.remotePort });
  if (prepared.recovery.ssh.owned && inspected.snapshot.listeners.length) fail(`首次新增要求远端端口 ${options.remotePort} 空闲。`);
  io.write('');
  io.write('即将配置：');
  io.write(`- 目标：${options.host}`);
  io.write(`- 转发：127.0.0.1:${options.remotePort} → 127.0.0.1:${options.localPort}`);
  io.write(`- SSH config：${prepared.recovery.ssh.owned ? '新增带标记的 RemoteForward' : '保留并复用等价转发'}（${options.sshConfig}）`);
  io.write(`- Remote settings：${prepared.recovery.settings.owned ? '局部设置两个代理字段' : '保留并复用等价字段'}（${options.remoteSettings}）`);
  io.write('- 影响：该远端用户的其他 VS Code 扩展也可能读取这些代理设置。');
  io.write(`- 恢复记录：${paths.directory}`);
  if (!io.isInteractive) fail('当前不是交互终端，未进行任何修改。');
  if (!(await io.confirm('确认以上增量吗？'))) { io.write('已取消，没有修改。'); return 0; }
  return withOperationLock(paths, ops, async () => {
    if (await readState(paths, ops, false)) fail('已有未移除的目标记录。');
    const freshSsh = await regularFileText(options.sshConfig, ops);
    const freshRemote = await ops.remoteRead({ host: options.host, sshConfig: options.sshConfig }, options.remoteSettings);
    if (sha256(freshSsh) !== prepared.recovery.ssh.beforeHash || freshRemote.hash !== prepared.recovery.settings.beforeHash) fail('确认后配置摘要已变化；未修改配置。');
    const refreshed = ops.prepareEdits({ sshText: freshSsh, settingsText: freshRemote.text, host: options.host, localPort: options.localPort, remotePort: options.remotePort });
    if (refreshed.recovery.ssh.afterHash !== prepared.recovery.ssh.afterHash || refreshed.recovery.settings.afterHash !== prepared.recovery.settings.afterHash) fail('确认后预期增量已变化；未修改配置。');
    const state = {
      version: STATE_VERSION, host: options.host, localProxy: options.localProxy, localPort: options.localPort,
      remotePort: options.remotePort, sshConfig: options.sshConfig, remoteSettings: options.remoteSettings,
      remoteMode: freshRemote.exists ? freshRemote.mode : '600', listenerTool: inspected.snapshot.listenerTool,
      phase: 'prepared', remoteStaging: null, recovery: refreshed.recovery,
    };
    await createState(paths, state, ops);
    try {
      if (state.recovery.ssh.owned) {
        await ops.atomicLocalWrite({ filePath: state.sshConfig, expectedHash: state.recovery.ssh.beforeHash, text: refreshed.sshText });
        await updatePhase(paths, state, 'local-written', ops);
        const effectiveAfter = await ops.sshEffective({ host: state.host, sshConfig: state.sshConfig });
        assertOnlyExpectedForwardAdded(inspected.snapshot.sshEffective, effectiveAfter, state.remotePort, state.localPort);
      }
      if (state.recovery.settings.owned) {
        await writeRemote(state, refreshed.settingsText, state.recovery.settings.beforeHash, paths, ops);
        await updatePhase(paths, state, 'remote-written', ops);
      }
      const applied = await readCurrent(state, ops);
      if (sha256(applied.sshText) !== state.recovery.ssh.afterHash || applied.remote.hash !== state.recovery.settings.afterHash) fail('写入后复读摘要不匹配。');
      await updatePhase(paths, state, 'applied', ops);
    } catch (error) {
      const restored = await restoreState(paths, state, ops);
      if (restored) await deleteState(paths, ops).catch(() => {});
      if (!restored) fail(recoveryInstructions(paths, state, '配置中断且无法确认完整恢复；已保留恢复记录，需要恢复。'));
      throw error;
    }
    io.write('✅ 配置已写入并复读；需要重连后才能验证 Codex。');
    io.write(`下一步：保存工作，关闭目标远端窗口，用同一 alias（${state.host}）重连并重新打开 Codex。`);
    return 0;
  });
}

async function configureExisting(input, state, io, paths, ops) {
  resolveRecordedOptions(input, state);
  assertNoPendingStaging(state);
  return withOperationLock(paths, ops, async () => {
    const lockedState = await readState(paths, ops);
    if (JSON.stringify(lockedState) !== JSON.stringify(state)) fail('恢复记录已变化，停止操作。');
    const current = await readCurrent(state, ops);
    if (sha256(current.sshText) !== state.recovery.ssh.afterHash || current.remote.hash !== state.recovery.settings.afterHash) fail('当前配置与本次记录的应用后摘要不符；停止覆盖。');
    const prepared = ops.prepareEdits({ sshText: current.sshText, settingsText: current.remote.text, host: state.host, localPort: state.localPort, remotePort: state.remotePort });
    if (prepared.changed) fail('本次记录存在但配置仍有增量；停止覆盖。');
    const endpoint = await ops.checkConfiguredEndpoint({ host: state.host, sshConfig: state.sshConfig }, state.listenerTool, state.remotePort);
    if (endpoint.status === 'fail') fail(endpoint.message);
    io.write(`${endpoint.status === 'pass' ? '✅' : 'ℹ️'} ${endpoint.message}`);
    return 0;
  });
}

async function configure(input, io, paths, ops) {
  const existing = await readState(paths, ops, false);
  if (existing) return configureExisting(input, existing, io, paths, ops);
  return configureNew(await resolveNewConfigureOptions(input, io), io, paths, ops);
}

async function remove(input, io, paths, ops) {
  const initial = await readState(paths, ops);
  const options = resolveRecordedOptions(input, initial);
  assertNoPendingStaging(initial);
  assertAppliedOrOriginal(initial, await readCurrent(initial, ops));
  io.write('');
  io.write('即将移除本次拥有的配置：');
  io.write(`- Remote settings：${initial.recovery.settings.owned ? '恢复本次字段编辑' : '保留用户等价设置'}`);
  io.write(`- SSH config：${initial.recovery.ssh.owned ? '移除本次标记片段' : '保留用户等价转发'}`);
  io.write(`- 恢复记录：${paths.active}`);
  if (!io.isInteractive) fail('当前不是交互终端，未进行任何修改。');
  if (!(await io.confirm('确认移除吗？'))) { io.write('已取消，没有修改。'); return 0; }
  return withOperationLock(paths, ops, async () => {
    const state = await readState(paths, ops);
    if (JSON.stringify(state) !== JSON.stringify(initial)) fail('恢复记录已变化，停止移除。');
    resolveRecordedOptions(options, state);
    assertAppliedOrOriginal(state, await readCurrent(state, ops));
    if (!(await restoreState(paths, state, ops))) {
      fail(recoveryInstructions(paths, state, '无法确认完整恢复；已保留恢复记录，需要恢复。'));
    }
    await deleteState(paths, ops);
    io.write('✅ 本次拥有的配置已恢复并复读，恢复记录已删除。请重连 VS Code Remote SSH 后复查。');
    return 0;
  });
}

async function verify(input, io, paths, ops) {
  const state = await readState(paths, ops);
  const options = resolveRecordedOptions(input, state);
  assertNoPendingStaging(state);
  const current = await readCurrent(state, ops);
  if (sha256(current.sshText) !== state.recovery.ssh.afterHash || current.remote.hash !== state.recovery.settings.afterHash) fail('配置与本次记录摘要不符；停止验证。');
  const result = await ops.verifyTarget(
    {
      host: state.host,
      sshConfig: state.sshConfig,
      remoteSettings: state.remoteSettings,
      pid: options.pid,
      targetUrl: TARGET_URL,
    },
    { localProxy: state.localProxy, localPort: state.localPort, remotePort: state.remotePort, listenerTool: state.listenerTool },
  );
  printChecks(result, io);
  if (!result.ok) fail('验证证据不足；未修改配置。');
  io.write('ℹ️ 自动检查已通过且主动网络探测已结束；仍需人工请求及目标进程到代理端口的关联证据。');
  return 0;
}

export async function runCommand({ command, options = {}, io = defaultIo(), dependencies = {} }) {
  const ops = operations(dependencies);
  try {
    const paths = statePaths(dependencies);
    if (command === 'configure') return await configure(options, io, paths, ops);
    if (command === 'remove') return await remove(options, io, paths, ops);
    if (command === 'verify') return await verify(options, io, paths, ops);
    fail(`不支持的命令：${command}`);
  } catch (error) {
    if (error instanceof ExpectedError || error instanceof ConfigError || error instanceof CancelledError) io.write(`❌ ${error.message}`);
    else io.write('❌ 未预期错误；未展示可能含敏感信息的原始内容。');
    return 1;
  }
}

async function main() {
  const io = defaultIo();
  try {
    const command = process.argv[2];
    const options = parseArgs(process.argv.slice(2));
    process.exitCode = await runCommand({ command, options, io });
  } catch (error) {
    io.write(`❌ ${error instanceof ExpectedError ? error.message : '参数解析失败。'}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
