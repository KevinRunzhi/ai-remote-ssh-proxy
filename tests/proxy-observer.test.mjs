import assert from 'node:assert/strict';
import test from 'node:test';
import { observerParameters, parseObservation, observeProxyConnection } from '../scripts/proxy-observer.mjs';
import { parseObserverArgs, runObservation } from '../scripts/observe-proxy.mjs';
import { CancelledError } from '../scripts/ssh.mjs';
import { candidateCodexVersion } from '../scripts/workflow.mjs';

const options = { pid: 123, remotePort: 17890, version: '26.1007.21434', architecture: 'x86_64', seconds: 2 };
const receipt = '__CODEX_PROXY_V1__\nstatus=connection-observed\npid=123\nstart=9999999999999999\nport=17890\nsamples=8\nbaseline=1\ninode=9999999999999998\nfirst=3\n';
const targetId = '00000000-0000-4000-8000-000000000001';
const cycleId = '00000000-0000-4000-8000-000000000002';

test('只读采集保留精确进程启动/inode；已有连接不升级为新连接证据', () => {
  const observed = parseObservation(receipt, options);
  assert.equal(observed.status, 'observed');
  assert.equal(observed.processStartTicks, '9999999999999999');
  assert.equal(observed.newSocketInode, '9999999999999998');
  const none = receipt.replace('connection-observed', 'no-new-connection').replace('inode=9999999999999998', 'inode=0').replace('first=3', 'first=0');
  assert.equal(parseObservation(none, options).status, 'unknown');
  for (const reason of ['identity-unverified', 'process-changed', 'unavailable']) {
    assert.deepEqual(parseObservation(`__CODEX_PROXY_V1__\nstatus=${reason}\n`, options), { status: 'unknown', reason });
  }
});

test('跨 PID/端口、错误窗口、矛盾回执与非白名单输出拒绝且不泄露正文', () => {
  for (const invalid of [receipt.replace('pid=123', 'pid=124'), receipt.replace('port=17890', 'port=17891'),
    receipt.replace('samples=8', 'samples=0'), receipt.replace('samples=8', 'samples=9'), receipt.replace('baseline=1', 'baseline=4097'),
    receipt.replace('first=3', 'first=9'), receipt.replace('first=3', 'first=0'),
    receipt.replace('inode=9999999999999998', 'inode=0'), receipt + 'TOKEN=TEST_SECRET\n',
    '__CODEX_PROXY_V1__\nstatus=process-changed\nTOKEN=TEST_SECRET\n', 'TEST_SECRET', 'x'.repeat(2049)]) {
    assert.throws(() => parseObservation(invalid, options), (error) => !error.message.includes('TEST_SECRET'));
  }
});

test('按实际时间收尾允许少于理论上限的采样，首次观察不能超出实际采样数', () => {
  const actual = parseObservation(receipt.replace('samples=8', 'samples=4'), options);
  assert.equal(actual.samples, 4); assert.equal(actual.firstSeenSample, 3);
  assert.throws(() => parseObservation(receipt.replace('samples=8', 'samples=2'), options));
});

test('参数只接受有限采集窗口和已支持平台；不将任意字符串放进脚本', () => {
  assert.deepEqual(observerParameters(options), ['123', '17890', 'openai.chatgpt-26.1007.21434-linux-x64', '2']);
  assert.match(observerParameters({ ...options, architecture: 'aarch64' })[2], /linux-arm64$/);
  for (const changed of [{ pid: 0 }, { pid: '123;exit' }, { remotePort: 22 }, { seconds: 0 }, { seconds: 121 },
    { seconds: 1.5 }, { architecture: 'windows-x64' }, { version: '26.1007.21434;curl secret' }]) {
    assert.throws(() => observerParameters({ ...options, ...changed }));
  }
  assert.deepEqual(parseObserverArgs(['--target-id', targetId, '--pid', '123']), { targetId, pid: 123, seconds: 60 });
  for (const args of [[], ['--target-id', targetId, '--pid', '1', '--pid', '2'], ['--target-id', targetId, '--pid', '1', '--seconds', '121'],
    ['--target-id', '../other', '--pid', '1'], ['--target-id', targetId, '--pid', '1', '--command', 'secret']]) assert.throws(() => parseObserverArgs(args));
});

test('采集只调用一次隔离 SSH，不运行 HTTPS 探针；取消不返回成功回执', async () => {
  const signal = new AbortController().signal;
  const transport = { host: 'sample', sshConfig: 'config', signal };
  let calls = 0;
  const result = await observeProxyConnection(transport, options, { runSsh: async (...args) => {
    calls++;
    assert.equal(args[0], transport); assert.deepEqual(args[2], observerParameters(options));
    assert.equal(args[3], 17_000); assert.equal(args[4], 'sh');
    assert.doesNotMatch(args[1], /curl|environ|https:\/\/|\.json/);
    return receipt;
  } });
  assert.equal(calls, 1); assert.equal(result.status, 'observed');
  await assert.rejects(observeProxyConnection(transport, options, { runSsh: async () => { throw new CancelledError('cancel'); } }), CancelledError);
});

function fixture() {
  const resource = { state: 'applied', pendingWrite: null };
  const target = { targetId, targetRevision: 5, lifecycle: 'active', currentCycleId: cycleId,
    connection: { alias: 'sample', hostname: 'sample.test', username: 'root', sshPort: 22, sshConfig: 'config' },
    connectionResource: { ...resource }, preparation: { base: { home: '/root', uid: 0, architecture: 'x86_64', listenerTool: 'proc' } },
    proxyCycles: [{ cycleId, status: 'configured', parameters: { localProxy: 'http://127.0.0.1:7897', remotePort: 17890 },
      forwarding: { ...resource }, settings: { ...resource, path: '/root/.vscode-server/data/Machine/settings.json' } }] };
  const snapshot = { entry: { hash: 'entry' }, current: { hash: 'target', value: target }, legacy: false, pending: [] };
  const calls = [];
  const dependencies = {
    directory: 'fixture-state', acquireInstance: async () => { calls.push('lock'); return { release: async () => calls.push('release') }; },
    store: { inspect: async () => structuredClone(snapshot) },
    sshEffective: async () => { calls.push('effective'); return 'hostname sample.test\nuser root\nport 22\n'; },
    preflightRemote: async (options) => {
      calls.push('registered'); assert.equal(options.codexHome, '/root'); assert.equal(options.codexArchitecture, 'x86_64');
      return { version: `openai.chatgpt-${candidateCodexVersion}-linux-x64`, registryHash: 'a'.repeat(64) };
    },
    verifyTarget: async (transport, record, nested) => {
      calls.push('prechecks'); assert.equal(transport.pid, 123); assert.equal(record.localPort, 7897);
      assert.equal(transport.codexExtension, `openai.chatgpt-${candidateCodexVersion}-linux-x64`);
      assert.equal(transport.codexRegistryHash, 'a'.repeat(64));
      await nested.preflightRemote({ host: 'sample' }); return { ok: true, checks: [] };
    },
    preflightRemoteBase: async () => { calls.push('base'); return structuredClone(target.preparation.base); },
    observeProxyConnection: async () => { calls.push('observe'); return parseObservation(receipt, options); },
  };
  const io = { confirm: async () => { calls.push('original'); return true; }, confirmReply: async () => { calls.push('reply'); return true; } };
  return { target, snapshot, dependencies, io, calls, run: () => runObservation({ targetId, pid: 123, seconds: 2 }, io, dependencies) };
}

test('维护入口独占实例，先结束全部探测再采集；人类回复与进程连接分别记录', async () => {
  const f = fixture(); const before = structuredClone(f.snapshot);
  const result = await f.run();
  assert.deepEqual(f.calls, ['lock', 'original', 'effective', 'registered', 'prechecks', 'base', 'observe', 'reply', 'release']);
  assert.equal(result.targetId, targetId); assert.equal(result.cycleId, cycleId); assert.equal(result.targetRevision, 5);
  assert.equal(result.proxyAttribution, 'target-process-connection-observed'); assert.equal(result.userUsability, 'user-confirmed');
  assert.deepEqual(f.snapshot, before);
  f.io.confirmReply = async () => false;
  assert.equal((await f.run()).userUsability, 'unconfirmed');
  f.dependencies.observeProxyConnection = async () => ({ status: 'unknown', reason: 'no-new-connection' });
  f.io.confirmReply = async () => true;
  const unknown = await f.run(); assert.equal(unknown.userUsability, 'user-confirmed'); assert.equal(unknown.proxyAttribution, 'unconfirmed');
});

test('旧记录/未配置/未结束写入/不同目标，不采集也不自动修复', async () => {
  for (const change of [(f) => { f.snapshot.legacy = true; }, (f) => { f.snapshot.pending.push('transition'); },
    (f) => { f.target.proxyCycles[0].status = 'preparing'; }, (f) => { f.target.proxyCycles[0].settings.pendingWrite = {}; },
    (f) => { f.target.lifecycle = 'archived'; }, (f) => { f.target.targetId = cycleId; }]) {
    const f = fixture(); change(f);
    await assert.rejects(f.run(), /初始化及状态核对/); assert.deepEqual(f.calls, ['lock', 'release']);
  }
  const f = fixture(); f.dependencies.acquireInstance = async () => { throw new Error('busy'); };
  await assert.rejects(f.run(), /busy/); assert.deepEqual(f.calls, []);
});

test('原容器声明拒绝、有效入口变化、基础身份变化、前置失败均不采集', async () => {
  const declined = fixture(); declined.io.confirm = async () => false;
  await assert.rejects(declined.run(), /未声明/); assert.deepEqual(declined.calls, ['lock', 'release']);
  const changed = fixture(); changed.dependencies.sshEffective = async () => 'hostname other.test\nuser root\nport 22\n';
  await assert.rejects(changed.run(), /有效 SSH/); assert.ok(!changed.calls.includes('prechecks'));
  const base = fixture(); base.dependencies.preflightRemoteBase = async () => ({ ...base.target.preparation.base, uid: 42 });
  await assert.rejects(base.run(), /原容器/); assert.ok(!base.calls.includes('observe')); assert.equal(base.calls.at(-1), 'release');
  const failed = fixture(); failed.dependencies.verifyTarget = async () => ({ ok: false, checks: [{ layer: 'ssh', status: 'unknown' }] });
  const result = await failed.run(); assert.equal(result.proxyAttribution, 'unconfirmed'); assert.ok(!failed.calls.includes('observe'));
});

test('等待及采集后来源变化使证据失效，仍释放实例', async () => {
  const waiting = fixture(); waiting.io.confirm = async () => { waiting.snapshot.current.hash = 'changed'; return true; };
  await assert.rejects(waiting.run(), /记录已变化/); assert.ok(!waiting.calls.includes('effective')); assert.equal(waiting.calls.at(-1), 'release');
  const sampling = fixture(); sampling.dependencies.observeProxyConnection = async () => { sampling.snapshot.current.hash = 'changed'; return parseObservation(receipt, options); };
  await assert.rejects(sampling.run(), /记录已变化/); assert.ok(!sampling.calls.includes('reply')); assert.equal(sampling.calls.at(-1), 'release');
});

test('采集拒绝未注册候选和缺少摘要，注册检查后记录变化也停止', async () => {
  for (const codex of [{ version: null }, { version: 'openai.chatgpt-26.901.22334-linux-x64', registryHash: 'a'.repeat(64) },
    { version: `openai.chatgpt-${candidateCodexVersion}-linux-x64` }]) {
    const f = fixture(); f.dependencies.preflightRemote = async () => codex;
    await assert.rejects(f.run(), /有效注册 Codex/);
    assert.ok(!f.calls.includes('prechecks')); assert.ok(!f.calls.includes('observe')); assert.equal(f.calls.at(-1), 'release');
  }
  const f = fixture(); const original = f.dependencies.preflightRemote;
  f.dependencies.preflightRemote = async (options) => { const codex = await original(options); f.snapshot.current.hash = 'changed'; return codex; };
  await assert.rejects(f.run(), /记录已变化/); assert.ok(!f.calls.includes('prechecks')); assert.equal(f.calls.at(-1), 'release');
});
