#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { createStateStore, defaultStateDirectory } from './state.mjs';
import { parseSshCommand, alias, configPath, port } from './input.mjs';
import { runOperation } from './workflow.mjs';
import { ExpectedError, CancelledError } from './ssh.mjs';
import { projectQuestion, projectResult } from '../app/projection.mjs';
import { verifyBundle } from './integrity.mjs';
import { acquireWorkingInstance } from './instance-recovery.mjs';

function fail(message) { throw new ExpectedError(message); }
export function parseArgs(argv) {
  const command = argv[0];
  if (!['configure', 'verify', 'remove', 'abandon'].includes(command)) fail('用法：runtime/node.exe scripts/e2e.mjs configure|verify|remove|abandon [--host alias | --ssh-command "ssh -p 22 root@host"] [--ssh-config 绝对路径] [--local-proxy URL] [--remote-port port] [--remote-settings path] [--pid number]');
  const allowed = new Set(['--host', '--ssh-config', '--remote-settings']);
  if (command === 'configure') for (const field of ['--ssh-command', '--local-proxy', '--remote-port']) allowed.add(field);
  if (command === 'verify') allowed.add('--pid');
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!allowed.has(key) || value === undefined) fail('无法识别的参数。');
    if (Object.hasOwn(values, key)) fail('参数重复。'); values[key] = value;
  }
  if (values['--host']) alias(values['--host']);
  if (values['--host'] !== undefined && values['--ssh-command'] !== undefined) fail('alias 和 SSH 命令不能同时填写。');
  if (values['--ssh-command'] !== undefined) parseSshCommand(values['--ssh-command']);
  if (values['--ssh-config'] !== undefined) configPath(values['--ssh-config']);
  if (values['--remote-settings'] !== undefined && (!values['--remote-settings'].startsWith('/') || /[\x00-\x1f\x7f]/.test(values['--remote-settings']))) fail('远端路径不受支持。');
  const pid = values['--pid'] === undefined ? undefined : Number(values['--pid']);
  if (pid !== undefined && (!/^\d+$/.test(values['--pid']) || !Number.isSafeInteger(pid) || pid < 1)) fail('PID 必须是正整数。');
  if (values['--remote-port'] !== undefined) port(values['--remote-port']);
  return { command, host: values['--host'], sshCommand: values['--ssh-command'], localProxy: values['--local-proxy'],
    remotePort: values['--remote-port'], sshConfig: values['--ssh-config'], remoteSettings: values['--remote-settings'], pid };
}

export function terminalIo(signal, onCancel = () => {}) {
  const prompt = async (label) => {
    if (signal.aborted) throw new CancelledError('已取消。');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const abort = () => rl.close(); signal.addEventListener('abort', abort, { once: true });
    rl.on('SIGINT', onCancel);
    try { return (await rl.question(`${label}：`, { signal })).trim(); }
    finally { signal.removeEventListener('abort', abort); rl.close(); }
  };
  const choose = async (question) => {
    const safe = projectQuestion(question);
    console.log(JSON.stringify(safe, null, 2));
    return prompt(`请输入选项 ${safe.choices.join(' / ')}`);
  };
  return { isInteractive: Boolean(process.stdin.isTTY && process.stderr.isTTY), prompt, choose, write: (text) => console.log(text) };
}

export async function runCli({ options, io, dependencies = {} }) {
  if (!io.isInteractive) { io.write('请使用 Windows 原生交互终端；认证只由 OpenSSH 接收。'); return 1; }
  let instance;
  try {
    const directory = dependencies.stateDirectory ?? defaultStateDirectory();
    instance = await (dependencies.acquireInstance ?? acquireWorkingInstance)(directory, { ...dependencies,
      confirmRecovery: async (question) => (await io.choose(question)) === 'confirm' });
    const store = (dependencies.createStateStore ?? createStateStore)(directory, instance);
    const observed = await store.inspect();
    if (observed.legacy || observed.pending.length) {
      const checked = await (dependencies.runOperation ?? runOperation)({ kind: 'resume', stateRecovery: { expectedEntryHash: observed.entry?.hash ?? null } },
        { confirm: io.choose, waitForUser: io.choose, notify: () => {} }, { ...dependencies, store, directory });
      io.write(JSON.stringify(projectResult(checked), null, 2)); return checked.outcome === 'failed' ? 1 : 0;
    }
    const current = observed.current?.value;
    let input;
    if (current) {
      if (options.host !== undefined && options.host !== current.connection.alias || options.sshConfig !== undefined && options.sshConfig !== current.connection.sshConfig
          || options.sshCommand !== undefined || options.localProxy !== undefined || options.remotePort !== undefined) fail('已有目标的连接和代理参数不可被命令行替换。');
      const kind = options.command === 'configure' ? 'resume' : options.command;
      const answer = await io.choose({ title: kind === 'abandon' ? '弃用记录中的旧目标；不会连接旧远端' : '声明这是记录中的原容器；重建后必须先弃用',
        connection: current.connection, previewRevision: 1, expiresAt: null, choices: ['confirm', 'cancel'] });
      if (answer !== 'confirm') return 0;
      input = { kind, targetId: current.targetId, expectedTargetRevision: current.targetRevision,
        ...(kind !== 'abandon' ? { declaration: 'original-container' } : {}), ...(options.pid !== undefined ? { pid: options.pid } : {}) };
      const cycle = current.proxyCycles.find((item) => item.cycleId === current.currentCycleId);
      if (kind === 'resume' && cycle?.status === 'removed') input.reconfigure = (await io.choose({ title: '明确新建代理配置周期', previewRevision: 2, expiresAt: null, choices: ['confirm', 'cancel'] })) === 'confirm';
    } else {
      if (options.command !== 'configure') fail('没有当前目标，请先 configure。');
      const preferences = (await store.readPreferences())?.value;
      const command = options.sshCommand ?? (options.host ? `ssh ${options.host}` : await io.prompt('输入简单 SSH 命令或 ssh alias；不要输入密码'));
      const declaration = await io.choose({ title: '声明这是新建或重建的容器', previewRevision: 1, expiresAt: null, choices: ['confirm', 'cancel'] });
      if (declaration !== 'confirm') return 0;
      input = { kind: 'initialize', declaration: 'new-or-rebuilt', connection: parseSshCommand(command),
        sshConfig: options.sshConfig ?? preferences?.sshConfig ?? path.join(os.homedir(), '.ssh', 'config'),
        localProxy: options.localProxy ?? preferences?.localProxy ?? await io.prompt('本机 HTTP 代理地址'), remotePort: options.remotePort ?? preferences?.remotePort ?? 17890,
        ...(preferences?.codePath ? { codePath: preferences.codePath } : {}) };
    }
    const result = await (dependencies.runOperation ?? runOperation)(input, {
      notify: (event) => { if (event.stage) io.write(`阶段：${event.stage}`); else if (event.status === 'waiting-user') io.write('请查看本终端 OpenSSH 提示并手工认证。'); },
      confirm: io.choose, waitForUser: io.choose,
    }, { ...dependencies, store, directory, expectedRemoteSettings: options.remoteSettings });
    io.write(JSON.stringify(projectResult(result), null, 2));
    return ['succeeded', 'needs-user', 'cancelled'].includes(result.outcome) ? 0 : 1;
  } catch (error) { io.write(error instanceof ExpectedError ? error.message : '操作未能安全完成；原始错误未展示，恢复记录已保留。'); return 1; }
  finally { if (instance) await instance.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController(), recovery = new AbortController();
  const cancel = () => { if (controller.signal.aborted) recovery.abort(); else controller.abort(); };
  const io = terminalIo(controller.signal, cancel);
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try { await verifyBundle(); process.exitCode = await runCli({ options: parseArgs(process.argv.slice(2)), io, dependencies: { signal: controller.signal, recoverySignal: recovery.signal } }); }
  catch (error) { io.write(error instanceof ExpectedError ? error.message : '启动失败。'); process.exitCode = 1; }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
