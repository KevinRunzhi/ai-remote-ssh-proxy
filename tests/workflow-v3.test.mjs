import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireInstance, createStateStore } from '../scripts/state.mjs';
import { runOperation, normalizeOperationInput, candidateCodexVersion } from '../scripts/workflow.mjs';
import { contentSnapshot, prepareEdits } from '../scripts/config.mjs';
import { CancelledError } from '../scripts/ssh.mjs';

const commit = '6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1';
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-workflow-v3-'));
  const instance = await acquireInstance(path.join(directory, 'state'), { restrictDirectory: async () => {} });
  t.after(async () => { await instance.release(); await fs.rm(directory, { recursive: true, force: true }); });
  const store = createStateStore(instance.directory, instance), file = path.join(directory, 'config');
  const original = '# keep\nHost unrelated\n  HostName other.test\n'; await fs.writeFile(file, original);
  let remote = '{"editor.tabSize":2,"private":"TEST_SECRET"}\n', offline = false, serverReady = true;
  const pendingPayloads = new Map(), calls = [], questions = [];
  const dependencies = {
    directory: instance.directory, store, restrictDirectory: async () => {},
    detectLocalTools: async () => ({ ready: true, vscode: { codePath: path.join(directory, 'Code.exe'), commit, version: '1.142.0' }, remoteSshVersion: '0.128.0' }),
    probeLocalProxy: async () => {},
    sshEffective: async (options) => {
      const text = await fs.readFile(file, 'utf8');
      const block = text.split(/^Host /m).find((part) => part.startsWith(`${options.host}\n`)) ?? '';
      return `hostname sample.test\nuser root\nport 22\n${block.includes('RemoteForward') ? 'remoteforward 127.0.0.1:17890 127.0.0.1:7897\n' : ''}`;
    },
    preflightRemoteBase: async () => { calls.push('base'); if (offline) throw new Error('offline'); return { uid: 0, home: '/root', architecture: 'x86_64', listenerTool: 'proc' }; },
    remoteListeners: async () => { calls.push('listeners'); return []; },
    locateRemoteServer: async () => { calls.push('server'); return serverReady ? { status: 'ready', settingsPath: '/root/.vscode-server/data/Machine/settings.json' } : { status: 'missing' }; },
    preflightRemote: async () => { calls.push('codex'); return { version: `openai.chatgpt-${candidateCodexVersion}-linux-x64` }; },
    remoteRead: async () => { calls.push('read'); if (offline) throw new Error('offline'); return { text: remote, mode: '640' }; },
    runScp: async (options, local, destination) => { calls.push('upload'); pendingPayloads.set(destination.split('/').slice(0, -1).join('/'), await fs.readFile(local, 'utf8')); },
    runRemoteProtocol: async (options, verb, protocol) => {
      calls.push(verb); if (offline) throw new Error('offline');
      if (verb === 'allocate') return { status: 'allocated', permit: 'open', snapshot: null };
      if (verb === 'write') { remote = protocol.request.split('\n')[6] === 'missing' ? null : pendingPayloads.get(protocol.stageRef.directory); return { status: 'applied', permit: 'closed', snapshot: contentSnapshot(remote) }; }
      if (verb === 'reconcile') return { status: 'reconciled', permit: 'closed', snapshot: contentSnapshot(remote) };
      return { status: 'cleaned', permit: 'closed', snapshot: null };
    },
    verifyTarget: async () => ({ ok: true, checks: ['local-proxy', 'ssh', 'remote-endpoint', 'target-https', 'codex-process'].map((layer) => ({ layer, status: 'pass', message: 'fixture' })) }),
  };
  const io = { notify: () => {}, confirm: async (question) => { questions.push(question); return 'confirm'; },
    waitForUser: async (question) => { questions.push(question); return question.choices.includes('new-reply') ? 'new-reply' : question.choices.includes('retain') ? 'retain' : 'ready'; } };
  const initialize = () => runOperation({ kind: 'initialize', declaration: 'new-or-rebuilt', connection: { inputMode: 'direct', hostname: 'sample.test', username: 'root' },
    sshConfig: file, localProxy: 'http://127.0.0.1:7897', remotePort: 17890 }, io, dependencies);
  const current = async () => (await store.inspect()).current?.value ?? null;
  const run = async (kind, extra = {}) => { const target = await current(); return runOperation({ kind, targetId: target.targetId,
    expectedTargetRevision: target.targetRevision, ...(kind !== 'abandon' ? { declaration: 'original-container' } : {}), ...extra }, io, dependencies); };
  return { directory, store, file, calls, questions, io, dependencies, initialize, current, run, original,
    remote: () => remote, setRemote: (value) => { remote = value; }, setOffline: (value) => { offline = value; }, setServerReady: (value) => { serverReady = value; } };
}

test('等价远端字段明确预览且不写入；本次转发未变时省去重连，新转发仍要求重连', async (t) => {
  for (const pauseForServer of [false, true]) {
    const f = await fixture(t);
    const existing = '{"http.useLocalProxyConfiguration":false,"http.proxy":"http://127.0.0.1:17890","private":"TEST_SECRET"}\n';
    f.setRemote(existing);
    if (pauseForServer) {
      f.setServerReady(false);
      f.io.waitForUser = async () => 'later';
      const paused = await f.initialize();
      assert.equal(paused.nextAction, 'prepare-server');
      f.setServerReady(true);
      f.io.waitForUser = async (question) => { f.questions.push(question); return question.choices.includes('new-reply') ? 'new-reply' : 'ready'; };
    }
    const result = pauseForServer ? await f.run('resume') : await f.initialize();
    assert.equal(result.outcome, 'succeeded', result.error);
    const preview = f.questions.find((question) => question.resource === 'settings');
    assert.ok(preview.changes.some((line) => line.includes('复用已有等价')));
    assert.ok(preview.changes.includes('http.proxy = http://127.0.0.1:17890'));
    assert.ok(!JSON.stringify(preview).includes('TEST_SECRET'));
    assert.equal(f.questions.filter((question) => question.title === '保存工作后重连目标 VS Code 窗口').length, pauseForServer ? 0 : 1);
    assert.ok(!f.calls.some((call) => ['allocate', 'upload', 'write', 'cleanup'].includes(call)));
    assert.equal(f.remote(), existing);
    const target = await f.current();
    assert.equal(target.proxyCycles[0].settings.state, 'reused');
    assert.equal(target.proxyCycles[0].settings.firstRecovery.owned, false);
  }
});

test('共享初始化→重复继续→检查→移除闭环；连接保留，人工回复和路径归因分开', async (t) => {
  const f = await fixture(t), remoteBefore = f.remote();
  const initialized = await f.initialize(); assert.equal(initialized.outcome, 'succeeded', initialized.error);
  assert.equal(initialized.userUsability, 'user-confirmed'); assert.equal(initialized.proxyAttribution, 'unconfirmed');
  assert.equal(initialized.checks.length, 5); assert.equal((await f.current()).proxyCycles[0].status, 'configured');
  assert.equal(f.calls.filter((call) => call === 'write').length, 1);
  assert.ok(!JSON.stringify(await f.current()).includes('TEST_SECRET'));
  const configured = await fs.readFile(f.file, 'utf8');
  const resumed = await f.run('resume'); assert.equal(resumed.outcome, 'succeeded', resumed.error);
  assert.equal(f.calls.filter((call) => call === 'write').length, 1); assert.equal(await fs.readFile(f.file, 'utf8'), configured);
  const revision = (await f.current()).targetRevision;
  const verified = await f.run('verify'); assert.equal(verified.outcome, 'succeeded', verified.error);
  assert.equal((await f.current()).targetRevision, revision); // verify 不补写历史业务状态。
  assert.equal((await f.run('remove')).outcome, 'succeeded');
  const retained = await fs.readFile(f.file, 'utf8'); assert.ok(retained.includes('# BEGIN codex-remote-connection'));
  assert.ok(!retained.includes('RemoteForward')); assert.ok(retained.startsWith('# keep\n')); assert.ok(retained.includes('Host unrelated\n  HostName other.test\n')); assert.equal(f.remote(), remoteBefore);
  const calls = f.calls.length; assert.equal((await f.run('remove')).outcome, 'succeeded'); assert.equal(f.calls.length, calls);
});

test('Server 未准备保留本机成功阶段；settings 从未触及时离线也能移除', async (t) => {
  const f = await fixture(t); f.setServerReady(false); f.io.waitForUser = async () => 'later';
  const paused = await f.initialize(); assert.equal(paused.outcome, 'needs-user'); assert.equal(paused.nextAction, 'prepare-server');
  const target = await f.current(); assert.equal(target.proxyCycles[0].settings.state, 'untouched'); assert.equal(target.proxyCycles[0].settings.path, null);
  f.calls.length = 0; f.setOffline(true);
  assert.equal((await f.run('remove')).outcome, 'succeeded'); assert.deepEqual(f.calls, []);
  assert.ok((await fs.readFile(f.file, 'utf8')).includes('Host codex-'));
});

test('弃用不连接 A；同地址/同路径 B 使用新身份，不能继承 A 的逆操作', async (t) => {
  const f = await fixture(t); assert.equal((await f.initialize()).outcome, 'succeeded');
  const before = await f.current(); f.calls.length = 0; f.setOffline(true);
  const abandoned = await f.run('abandon'); assert.equal(abandoned.outcome, 'succeeded', abandoned.error); assert.deepEqual(f.calls, []);
  assert.equal(await f.current(), null);
  f.setOffline(false); const second = await f.initialize(); assert.equal(second.outcome, 'succeeded', second.error);
  const after = await f.current(); assert.notEqual(after.targetId, before.targetId); assert.notEqual(after.connection.alias, before.connection.alias);
  assert.notEqual(after.currentCycleId, before.currentCycleId);
  assert.equal(after.proxyCycles[0].settings.firstRecovery.owned, false); // B 当前文件作为全新基线，即使与 A 相同。
  assert.equal((await f.store.readTarget(before.targetId)).value.lifecycle, 'archived');
});

test('已移除周期必须重新明确确认；新周期不覆盖旧 firstRecovery', async (t) => {
  const f = await fixture(t); await f.initialize(); await f.run('remove');
  const first = structuredClone((await f.current()).proxyCycles[0]);
  assert.equal((await f.run('resume')).nextAction, 'explicit-reconfiguration-required');
  const result = await f.run('resume', { reconfigure: true }); assert.equal(result.outcome, 'succeeded', result.error);
  const target = await f.current(); assert.equal(target.proxyCycles.length, 2); assert.deepEqual(target.proxyCycles[0], first);
  assert.notEqual(target.proxyCycles[1].cycleId, first.cycleId);
});

test('过期确认或等待期间目标 revision 变化，不能继续使用旧确认写配置', async (t) => {
  const f = await fixture(t); let time = 0; f.dependencies.now = () => time;
  f.io.confirm = async () => { time += 600_001; return 'confirm'; };
  assert.equal((await f.initialize()).outcome, 'failed'); assert.equal(await fs.readFile(f.file, 'utf8'), f.original);
  assert.equal(await f.current(), null);
});

test('唯一未完成入口切换经共享确认只收敛元数据，不执行目标动作', async (t) => {
  const f = await fixture(t); await f.store.initializeEntry();
  const instanceRecord = await fs.readFile(path.join(f.dependencies.directory, 'instance.lock'), 'utf8');
  let writes = 0;
  // 复用同一实例的持久化故障点，模拟目标意图已发布但入口尚未切换。
  const originalUpdate = f.store.createTarget;
  await originalUpdate({ expectedEntryRevision: 0, confirmedPreviewRevision: 1,
    connection: { alias: 'sample', hostname: 'sample.test', username: 'root', sshPort: 22, sshConfig: f.file } });
  const target = await f.current();
  const file = path.join(f.dependencies.directory, 'targets', `${target.targetId}.json`);
  target.pendingTransition.status = 'pending';
  await fs.writeFile(file, JSON.stringify(target));
  const before = await f.store.inspect();
  const outcome = await runOperation({ kind: 'resume', stateRecovery: { expectedEntryHash: before.entry.hash } }, {
    notify: () => {}, waitForUser: async () => assert.fail('不启动目标流程'), confirm: async () => { writes++; return 'confirm'; },
  }, f.dependencies);
  assert.equal(outcome.outcome, 'needs-user', outcome.error); assert.equal(writes, 1);
  assert.equal((await f.store.inspect()).pending.length, 0); assert.deepEqual(f.calls, []);
  assert.equal(await fs.readFile(path.join(f.dependencies.directory, 'instance.lock'), 'utf8'), instanceRecord);
});

test('元数据核对来源改变及混入目标参数被拒绝', async (t) => {
  const f = await fixture(t);
  assert.throws(() => normalizeOperationInput({ kind: 'resume', stateRecovery: { expectedEntryHash: null }, targetId: 'bad' }));
  const result = await runOperation({ kind: 'resume', stateRecovery: { expectedEntryHash: 'a'.repeat(64) } }, f.io, f.dependencies);
  assert.equal(result.outcome, 'failed'); assert.equal(await f.current(), null); assert.deepEqual(f.calls, []);
});

test('输入拒绝隐式覆盖旧目标、跨目标参数和秘密形态命令', () => {
  for (const input of [{ kind: 'initialize', declaration: 'original-container' }, { kind: 'remove', targetId: '../old', expectedTargetRevision: 1 },
    { kind: 'verify', targetId: [], expectedTargetRevision: 0 }, { kind: 'abandon', targetId: '00000000-0000-4000-8000-000000000001', expectedTargetRevision: 0, localProxy: 'http://user:secret@host' }]) {
    assert.throws(() => normalizeOperationInput(input));
  }
});

test('用户商店安装可稍后继续；不会提供下载入口，也不信任完成回答代替实际检查', async (t) => {
  const f = await fixture(t); let checks = 0;
  f.dependencies.preflightRemote = async () => { checks++; return { version: 'missing' }; };
  f.io.waitForUser = async (question) => {
    f.questions.push(question);
    assert.ok(!question.choices.some((choice) => choice.includes('download')));
    return question.title === '在目标远端窗口的商店安装 Codex' ? 'later' : 'ready';
  };
  assert.equal((await f.initialize()).nextAction, 'prepare-codex');
  assert.equal(checks, 1);
  const target = await f.current();
  assert.equal(target.proxyCycles[0].settings.state, 'applied');
  f.io.waitForUser = async () => 'ready';
  const result = await f.run('resume');
  assert.equal(result.outcome, 'needs-user'); assert.equal(result.nextAction.kind, 'codex-version'); assert.equal(checks, 3);
  assert.equal((await f.current()).preparation.packageStage, undefined);
});

test('注册或调用链检查异常不误导为重新安装，不泄露原始错误，取消仍传播', async (t) => {
  const f = await fixture(t);
  f.dependencies.preflightRemote = async (options) => {
    assert.equal(options.codexHome, '/root'); assert.equal(options.codexArchitecture, 'x86_64');
    throw new Error('TEST_SECRET');
  };
  const outcome = await f.initialize();
  assert.equal(outcome.outcome, 'needs-user'); assert.equal(outcome.nextAction.kind, 'codex-check');
  assert.ok(!JSON.stringify(outcome).includes('TEST_SECRET'));
  assert.ok(!f.questions.some(question => question.title === '在目标远端窗口的商店安装 Codex'));
  assert.equal((await f.current()).proxyCycles[0].settings.state, 'applied');
  f.dependencies.preflightRemote = async () => { throw new CancelledError('cancelled'); };
  assert.equal((await f.run('resume')).outcome, 'cancelled');
});

test('旧远端缺许可时不凭 phase 重放；本机冲突可明确全部保留后离线弃用', async (t) => {
  const f = await fixture(t);
  const prepared = prepareEdits({ sshText: f.original, settingsText: null, host: 'unrelated', localPort: 7897, remotePort: 17890 });
  const legacy = { version: 2, host: 'unrelated', sshConfig: f.file, localProxy: 'http://127.0.0.1:7897', localPort: 7897,
    remotePort: 17890, remoteSettings: '/root/.vscode-server/data/Machine/settings.json', remoteMode: '600', listenerTool: 'proc',
    remoteStaging: null, phase: 'applied', recovery: prepared.recovery };
  await fs.writeFile(path.join(f.dependencies.directory, 'active.json'), JSON.stringify(legacy));
  const observed = await f.store.inspect();
  const migrated = await f.store.migrateLegacy({ expectedSourceHash: observed.entry.hash, confirmedPreviewRevision: 1 });
  await assert.rejects(f.store.updateTarget(migrated.targetId, migrated.targetRevision, (value) => {
    value.migration.phase = 'local-written'; return value;
  }), /迁移来源/);
  const blocked = await f.run('remove');
  assert.equal(blocked.nextAction, 'legacy-remote-review-required'); assert.deepEqual(f.calls, []);
  const changed = prepared.sshText + '# user changed after configuration\n';
  await fs.writeFile(f.file, changed); f.setOffline(true);
  const abandoned = await f.run('abandon');
  assert.equal(abandoned.outcome, 'succeeded', abandoned.error); assert.deepEqual(f.calls, []);
  assert.equal(await fs.readFile(f.file, 'utf8'), changed);
  assert.equal(await f.current(), null);
  assert.equal((await f.store.readTarget(migrated.targetId)).value.abandonment.localCleanup, 'retained');
  assert.ok(f.questions.some((question) => question.title === '弃用旧容器并保留全部本机文件' && question.choices.join(',') === 'confirm,cancel'));
});
