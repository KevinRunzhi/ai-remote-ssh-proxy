// 维护者验收入口；不随用户工具包交付。先正常退出网页工具，再在原生终端运行。
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { acquireInstance, createStateStore, defaultStateDirectory } from './state.mjs';
import { ExpectedError, sshEffective, effectiveConnection, preflightRemote, verifyTarget } from './ssh.mjs';
import { preflightRemoteBase } from './preflight.mjs';
import { candidateCodexVersion } from './workflow.mjs';
import { observeProxyConnection, observerParameters } from './proxy-observer.mjs';

function fail(message) { throw new ExpectedError(message); }
export function parseObserverArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--target-id', '--pid', '--seconds'].includes(key) || values[key] !== undefined || value === undefined) fail('用法：node scripts/observe-proxy.mjs --target-id UUID --pid 进程号 [--seconds 60]');
    values[key] = value;
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(values['--target-id'] ?? '')
      || !/^[1-9]\d*$/.test(values['--pid'] ?? '') || !Number.isSafeInteger(Number(values['--pid']))
      || values['--seconds'] !== undefined && !/^(?:[1-9]|[1-9]\d|1[01]\d|120)$/.test(values['--seconds'])) fail('目标、PID 或采集时长无效。');
  return { targetId: values['--target-id'], pid: Number(values['--pid']), seconds: Number(values['--seconds'] ?? 60) };
}

export async function runObservation(input, io, dependencies = {}) {
  // 编程入口与 CLI 使用同一输入校验，不允许未校验参数进入 SSH。
  input = parseObserverArgs(['--target-id', input.targetId, '--pid', String(input.pid), '--seconds', String(input.seconds ?? 60)]);
  const directory = dependencies.directory ?? defaultStateDirectory();
  const instance = await (dependencies.acquireInstance ?? acquireInstance)(directory);
  const ops = { sshEffective, effectiveConnection, preflightRemote, verifyTarget, preflightRemoteBase, observeProxyConnection, ...dependencies };
  try {
    const store = dependencies.store ?? createStateStore(directory, instance);
    const initial = await store.inspect();
    const target = initial.current?.value;
    const cycle = target?.proxyCycles.find((item) => item.cycleId === target.currentCycleId);
    if (initial.legacy || initial.pending.length || !target || target.targetId !== input.targetId || target.lifecycle !== 'active'
        || cycle?.status !== 'configured' || !target.preparation.base || target.migration
        || [target.connectionResource, cycle?.forwarding, cycle?.settings].some((resource) => !resource || !['applied', 'reused'].includes(resource.state) || resource.pendingWrite)) fail('请先完成当前目标初始化及状态核对；采集不迁移、修复或改写配置。');
    const unchanged = async () => {
      const current = await store.inspect();
      if (current.entry?.hash !== initial.entry.hash || current.current?.hash !== initial.current.hash || current.pending.length) fail('采集期间目标或记录已变化；证据未计为通过。');
    };
    if (!await io.confirm({ targetId: target.targetId, alias: target.connection.alias, pid: input.pid, seconds: input.seconds })) fail('未声明这是原容器，采集未启动。');
    await unchanged();
    const transport = { host: target.connection.alias, sshConfig: target.connection.sshConfig, signal: dependencies.signal };
    const identity = ops.effectiveConnection(await ops.sshEffective(transport));
    if (['hostname', 'username', 'sshPort'].some((key) => identity[key] !== target.connection[key])) fail('有效 SSH 连接已变化；未连接目标。');
    const base = target.preparation.base;
    observerParameters({ pid: input.pid, remotePort: cycle.parameters.remotePort, version: candidateCodexVersion, architecture: base.architecture, seconds: input.seconds });
    const codex = await ops.preflightRemote({ ...transport, codexHome: base.home, codexArchitecture: base.architecture });
    const expected = `openai.chatgpt-${candidateCodexVersion}-${base.architecture === 'x86_64' ? 'linux-x64' : 'linux-arm64'}`;
    if (codex.version !== expected || !/^[a-f0-9]{64}$/.test(codex.registryHash ?? '')) fail('当前有效注册 Codex 与候选或注册摘要不符；采集未启动。');
    await unchanged();
    // 自动 HTTPS 探测完全结束后才进入观察窗口，不能把探测流量当作用户请求。
    const checked = await ops.verifyTarget({ ...transport, pid: input.pid, remoteSettings: cycle.settings.path,
      codexExtension: codex.version, codexRegistryHash: codex.registryHash },
      { ...cycle.parameters, localPort: Number(new URL(cycle.parameters.localProxy).port), listenerTool: base.listenerTool }, {
        preflightRemote: async (options) => {
          const actual = await ops.preflightRemoteBase(options);
          if (['uid', 'home', 'architecture'].some((key) => actual[key] !== base[key])) fail('原容器用户/home/架构不一致。');
          return actual;
        },
      });
    if (!checked.ok) return { status: 'unknown', reason: 'prechecks-incomplete', checks: checked.checks, userUsability: 'unconfirmed', proxyAttribution: 'unconfirmed' };
    await unchanged();
    const startedAt = new Date().toISOString();
    const observation = await ops.observeProxyConnection(transport, { pid: input.pid, remotePort: cycle.parameters.remotePort,
      version: candidateCodexVersion, architecture: base.architecture, seconds: input.seconds });
    await unchanged();
    const endedAt = new Date().toISOString();
    const newReply = await io.confirmReply();
    await unchanged();
    return { version: 1, targetId: target.targetId, cycleId: cycle.cycleId, targetRevision: target.targetRevision,
      startedAt, endedAt, observation, userUsability: newReply ? 'user-confirmed' : 'unconfirmed',
      proxyAttribution: observation.status === 'observed' ? 'target-process-connection-observed' : 'unconfirmed',
      limitations: ['仅证明目标进程在观察窗口内建立到代理的新连接；不读取请求内容，也不证明具体 HTTPS 目的地。',
        '采集开始前已有的连接或采样间隙内结束的连接不能形成新连接证据；此时保留未知。'] };
  } finally { await instance.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const ask = async (prompt) => {
    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return await terminal.question(prompt, { signal: controller.signal }); } finally { terminal.close(); }
  };
  try {
    if (!process.stdin.isTTY || !process.stderr.isTTY) fail('需要 Windows 原生交互终端，密码只在 OpenSSH 提示输入。');
    const input = parseObserverArgs(process.argv.slice(2));
    const result = await runObservation(input, {
      confirm: async ({ targetId, alias, pid, seconds }) => {
        console.log(`目标 ${targetId} / ${alias}，PID ${pid}，观察 ${seconds} 秒。请先正常退出网页工具。`);
        return await ask('确认这是记录中的原容器，输入 ORIGINAL：') === 'ORIGINAL';
      },
      confirmReply: async () => await ask('若在刚才观察窗口内发起请求并收到新回复，输入 REPLY；否则直接回车：') === 'REPLY',
    }, { signal: controller.signal });
    const folder = new URL('../.cache/', import.meta.url);
    await fs.mkdir(folder, { recursive: true });
    const file = new URL(`proxy-observation-${randomUUID()}.json`, folder);
    await fs.writeFile(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
    console.log(`只读证据已保存：${file.pathname}`);
  } catch (error) { console.error(error instanceof ExpectedError ? error.message : '采集未完成；原始错误未展示，未改写配置。'); process.exitCode = 1; }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
