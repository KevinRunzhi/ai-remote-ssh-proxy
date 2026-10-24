import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { acquireInstance, readRecord, assertPlainDirectory, createStateStore } from '../scripts/state.mjs';
import { prepareEdits, sha256 } from '../scripts/config.mjs';
import { planRemoteWrite } from '../scripts/remote-protocol.mjs';
import { randomUUID } from 'node:crypto';

async function fixture(t, cleanup = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-state-test-'));
  if (cleanup) t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, directory: path.join(root, 'data'), deps: { restrictDirectory: async () => {} } };
}

test('工作实例锁独占且整个等待期间持有，释放幂等', async (t) => {
  const { directory, deps } = await fixture(t);
  const first = await acquireInstance(directory, deps);
  assert.equal(typeof first.owner.ownerId, 'string');
  await assert.rejects(acquireInstance(directory, deps), /已有工作实例/);
  await first.release(); await first.release();
  const second = await acquireInstance(directory, deps); await second.release();
});

test('并发退出共享收尾，退出发起后禁止新写入', async (t) => {
  const { directory, deps } = await fixture(t);
  const instance = await acquireInstance(directory, deps);
  const closing = instance.release();
  await assert.rejects(instance.withWriteLock(async () => assert.fail('不得写入')));
  await Promise.all([closing, instance.release(), instance.release()]);
  const next = await acquireInstance(directory, deps); await next.release();
});

test('遗留或损坏锁不按 PID、超时或内容自动删除', async (t) => {
  const { directory, deps } = await fixture(t);
  await fs.mkdir(directory);
  const file = path.join(directory, 'instance.lock');
  for (const text of ['99999999\n', 'bad-json', '{"pid":0}']) {
    await fs.writeFile(file, text);
    await assert.rejects(acquireInstance(directory, deps));
    assert.equal(await fs.readFile(file, 'utf8'), text);
  }
});

test('锁归属变化不删除其他实例文件；ACL 失败不创建锁', async (t) => {
  const { directory, deps } = await fixture(t);
  const instance = await acquireInstance(directory, deps);
  const file = path.join(directory, 'instance.lock');
  await fs.writeFile(file, '{"ownerId":"someone-else"}\n');
  await assert.rejects(instance.release(), /归属变化/);
  assert.equal((await readRecord(file)).value.ownerId, 'someone-else');
  const second = `${directory}-second`;
  await assert.rejects(acquireInstance(second, { restrictDirectory: async () => { throw new Error('ACL'); } }));
  await assert.rejects(fs.stat(path.join(second, 'instance.lock')), { code: 'ENOENT' });
});

test('状态读取拒绝非法 UTF-8、损坏 JSON、过大记录', async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, 'test.json');
  assert.equal(await readRecord(file), null);
  for (const data of [Buffer.from([0xff]), 'bad', 'x'.repeat(1024 * 1024 + 1)]) {
    await fs.writeFile(file, data);
    await assert.rejects(readRecord(file));
  }
});

test('目录链中的 junction/symlink 被拒绝，不接触被指向文件', async (t) => {
  const { root, deps } = await fixture(t);
  const actual = path.join(root, 'actual'); await fs.mkdir(actual);
  const link = path.join(root, 'linked');
  await fs.symlink(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertPlainDirectory(link), /链接/);
  await assert.rejects(acquireInstance(path.join(link, 'data'), deps), /链接/);
  assert.deepEqual(await fs.readdir(actual), []);
});

async function storeFixture(t) {
  const values = await fixture(t, false);
  const instance = await acquireInstance(values.directory, values.deps);
  t.after(async () => { await instance.release(); await fs.rm(values.root, { recursive: true, force: true }); });
  const store = createStateStore(values.directory, instance);
  return { ...values, instance, store };
}
const connection = { alias: 'sample', hostname: 'sample.example', username: 'root', sshPort: 22, sshConfig: path.join(os.tmpdir(), 'config') };

test('深层恢复依据、暂存定位和协议字段损坏时只读拒绝，不改原件', async (t) => {
  const { store, directory } = await storeFixture(t);
  await store.initializeEntry();
  let target = await store.createTarget({ expectedEntryRevision: 0, confirmedPreviewRevision: 1, connection });
  target = await store.beginProxyCycle(target.targetId, target.targetRevision, 2, { localProxy: 'http://127.0.0.1:7897', remotePort: 17890 });
  const file = path.join(directory, 'targets', `${target.targetId}.json`), original = JSON.stringify(target);
  const writeId = randomUUID(), operationId = randomUUID(), expectedBefore = { exists: false, sha256: null }, expectedAfter = { exists: true, sha256: 'a'.repeat(64) };
  const protocol = planRemoteWrite({ operationId, writeId, action: 'apply', stageParent: '/root', targetPath: '/root/Machine/settings.json', expectedBefore, expectedAfter });
  const pending = { operationId, writeId, action: 'apply', confirmedPreviewRevision: 3, targetRevisionAtPlan: target.targetRevision,
    beforeState: 'untouched', expectedBefore, expectedAfter, stageRef: { ...protocol.stageRef, localDirectory: path.join(directory, `.upload-${writeId}`) },
    protocol, result: 'pending', permit: 'unknown' };
  const mutations = [
    (value) => { value.unrecognized = true; },
    (value) => { value.proxyCycles[0].parameters.remotePort = 22; },
    (value) => { value.connectionResource.path = path.join(directory, 'another-file'); },
    (value) => { value.connectionResource.firstRecovery = { owned: true, existed: true, snippet: 'x', beforeHash: 'not-a-hash', afterHash: 'a'.repeat(64) }; },
    (value) => { value.proxyCycles[0].settings.firstRecovery = { owned: true, existed: false, beforeHash: null, afterHash: 'a'.repeat(64), properties: {}, inverseSteps: [{ offset: 0, length: 1, content: 'TEST_SECRET' }] }; },
    (value) => { value.proxyCycles[0].settings.pendingWrite.stageRef.localDirectory = path.dirname(directory); },
    (value) => { value.proxyCycles[0].settings.pendingWrite.protocol.requestHash = 'b'.repeat(64); },
    (value) => { value.proxyCycles[0].settings.pendingWrite.stageRef.directory = '/tmp/unrelated'; },
    (value) => { value.proxyCycles[0].settings.pendingWrite.stageRef.localIdentity = { ino: 14355223812306938, dev: 1 }; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(target);
    value.proxyCycles[0].settings.path = '/root/Machine/settings.json'; value.proxyCycles[0].settings.pendingWrite = structuredClone(pending);
    mutate(value); const invalid = JSON.stringify(value); await fs.writeFile(file, invalid);
    await assert.rejects(store.inspect()); assert.equal(await fs.readFile(file, 'utf8'), invalid);
    await fs.writeFile(file, original);
  }
  assert.equal((await store.inspect()).current.value.targetId, target.targetId);
});

test('v3 空入口保留、创建仅改元数据、归档后不自动激活历史', async (t) => {
  const { directory, store } = await storeFixture(t);
  await store.initializeEntry();
  const target = await store.createTarget({ expectedEntryRevision: 0, confirmedPreviewRevision: 1, connection });
  assert.equal(target.targetRevision, 1);
  assert.equal((await store.readEntry()).value.entryRevision, 1);
  assert.equal(target.connectionResource.state, 'untouched');
  const abandoning = await store.beginAbandonment(target.targetId, target.targetRevision, 2);
  await assert.rejects(store.archiveTarget(target.targetId, abandoning.targetRevision, 3), /本机清理/);
  const retained = await store.updateTarget(target.targetId, abandoning.targetRevision, (value) => ({ ...value, abandonment: { ...value.abandonment, localCleanup: 'retained' } }));
  await store.archiveTarget(target.targetId, retained.targetRevision, 3);
  assert.equal((await store.readEntry()).value.currentTargetId, null);
  assert.equal((await store.readTarget(target.targetId)).value.lifecycle, 'archived');
  assert.equal((await store.inspect()).pending.length, 0);
  await store.reconcile();
  assert.equal((await store.readEntry()).value.currentTargetId, null);
  assert.ok((await fs.stat(path.join(directory, 'active.json'))).isFile());
  const next = await store.createTarget({ expectedEntryRevision: 2, confirmedPreviewRevision: 4, connection });
  assert.notEqual(next.targetId, target.targetId);
});

test('状态 revision 冲突拒绝；入口 revision 与目标 revision 分别递增', async (t) => {
  const { store } = await storeFixture(t);
  await store.initializeEntry();
  const target = await store.createTarget({ expectedEntryRevision: 0, confirmedPreviewRevision: 1, connection });
  const updated = await store.updateTarget(target.targetId, 1, (value) => ({ ...value, preparation: { declaration: 'new-or-rebuilt' } }));
  assert.equal(updated.targetRevision, 2);
  assert.equal((await store.readEntry()).value.entryRevision, 1);
  await assert.rejects(store.updateTarget(target.targetId, 1, (value) => value), /revision/);
  await assert.rejects(store.updateTarget(target.targetId, 2, (value) => ({ ...value, lifecycle: 'archived' })), /生命周期/);
  await assert.rejects(store.readTarget('../escape'), /标识/);
});

test('旧版 operation.lock 与实例内并发均不能绕过', async (t) => {
  const { directory, instance, store } = await storeFixture(t);
  const file = path.join(directory, 'operation.lock');
  await fs.writeFile(file, '9999999\n');
  await assert.rejects(store.initializeEntry(), /旧版锁/);
  assert.equal(await fs.readFile(file, 'utf8'), '9999999\n');
  await fs.unlink(file);
  let finish;
  const first = instance.withWriteLock(async () => { await new Promise((resolve) => { finish = resolve; }); });
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(instance.withWriteLock(async () => {}), /已有写入/);
  await assert.rejects(instance.release(), /尚未收尾/);
  finish(); await first;
  assert.equal(await fs.stat(file).catch(() => null), null);
});

test('未知/旧 schema 不覆盖，异常更新保留原记录', async (t) => {
  const { directory, store } = await storeFixture(t);
  const file = path.join(directory, 'active.json');
  await fs.writeFile(file, '{"version":2,"recovery":{"keep":true}}');
  await assert.rejects(store.initializeEntry(), /schema/);
  assert.equal(await fs.readFile(file, 'utf8'), '{"version":2,"recovery":{"keep":true}}');
});

test('入口已切换但目标完成标记未保存时，仅补记元数据', async (t) => {
  const { directory, store } = await storeFixture(t);
  await store.initializeEntry();
  const target = await store.createTarget({ expectedEntryRevision: 0, confirmedPreviewRevision: 1, connection });
  const file = path.join(directory, 'targets', `${target.targetId}.json`);
  target.pendingTransition.status = 'pending';
  await fs.writeFile(file, JSON.stringify(target));
  const before = await store.readEntry();
  await store.reconcile();
  assert.equal((await store.readEntry()).hash, before.hash);
  assert.equal((await store.readTarget(target.targetId)).value.pendingTransition.status, 'completed');
});

test('本机写入结果未知时不能弃用；不允许用归档绕过', async (t) => {
  const { store } = await storeFixture(t);
  await store.initializeEntry();
  const target = await store.createTarget({ expectedEntryRevision: 0, confirmedPreviewRevision: 1, connection });
  const changed = await store.updateTarget(target.targetId, target.targetRevision, (value) => ({ ...value, connectionResource: { ...value.connectionResource, state: 'unknown' } }));
  await assert.rejects(store.beginAbandonment(target.targetId, changed.targetRevision, 2), /本机写入/);
  await assert.rejects(store.beginAbandonment(target.targetId, changed.targetRevision, 2, true), /本机写入/);
  await assert.rejects(store.archiveTarget(target.targetId, changed.targetRevision, 2), /归档/);
});

test('孤立活动目标及矛盾切换 revision 保留原件且冻结核对', async (t) => {
  const { store, directory } = await storeFixture(t);
  await store.initializeEntry();
  const target = await store.createTarget({ expectedEntryRevision: 0, confirmedPreviewRevision: 1, connection });
  const file = path.join(directory, 'active.json');
  const entry = await store.readEntry();
  await fs.writeFile(file, JSON.stringify({ ...entry.value, currentTargetId: null }));
  const orphanEntry = await fs.readFile(file, 'utf8');
  await assert.rejects(store.reconcile(), /孤立目标/);
  assert.equal(await fs.readFile(file, 'utf8'), orphanEntry);
  await fs.writeFile(file, JSON.stringify({ ...entry.value, entryRevision: 9 }));
  const targetFile = path.join(directory, 'targets', `${target.targetId}.json`);
  target.pendingTransition.status = 'pending';
  await fs.writeFile(targetFile, JSON.stringify(target));
  await assert.rejects(store.reconcile(), /revision/);
  assert.equal((await store.readTarget(target.targetId)).value.pendingTransition.status, 'pending');
});

test('偏好 CAS 只保存明确本机默认值，不更改当前目标', async (t) => {
  const { store } = await storeFixture(t);
  await store.initializeEntry();
  const target = await store.createTarget({ expectedEntryRevision: 0, confirmedPreviewRevision: 1, connection });
  const before = await store.readTarget(target.targetId);
  const prefs = await store.savePreferences({ expectedRevision: null, values: { localProxy: 'http://localhost:7897/', remotePort: '17890' } });
  assert.equal(prefs.localProxy, 'http://127.0.0.1:7897');
  assert.equal(prefs.remotePort, 17890); assert.equal(prefs.revision, 0);
  await assert.rejects(store.savePreferences({ expectedRevision: null, values: { localProxy: 'http://localhost:7897', remotePort: 17890 } }), /revision/);
  await assert.rejects(store.savePreferences({ expectedRevision: 0, values: { localProxy: 'http://localhost:7897', remotePort: 17890, hostname: 'old-container' } }), /偏好字段/);
  assert.equal((await store.readTarget(target.targetId)).hash, before.hash);
  const next = await store.savePreferences({ expectedRevision: 0, values: { localProxy: 'http://localhost:7898', remotePort: 17891 } });
  assert.equal(next.revision, 1);
});

test('新代理周期采用独立基线，旧恢复依据和已结束结果不可覆盖', async (t) => {
  const { store } = await storeFixture(t);
  await store.initializeEntry();
  let target = await store.createTarget({ expectedEntryRevision: 0, confirmedPreviewRevision: 1, connection });
  const parameters = { localProxy: 'http://127.0.0.1:7897', remotePort: 17890 };
  target = await store.beginProxyCycle(target.targetId, target.targetRevision, 2, parameters);
  const firstId = target.currentCycleId;
  await assert.rejects(store.beginProxyCycle(target.targetId, target.targetRevision, 3, parameters), /尚未移除/);
  target = await store.updateTarget(target.targetId, target.targetRevision, (value) => {
    value.proxyCycles[0].forwarding.firstRecovery = { owned: false, existed: true, beforeHash: 'a'.repeat(64), afterHash: 'a'.repeat(64), snippet: '' };
    return value;
  });
  await assert.rejects(store.updateTarget(target.targetId, target.targetRevision, (value) => {
    value.proxyCycles[0].forwarding.firstRecovery = null; return value;
  }), /恢复依据/);
  target = await store.updateTarget(target.targetId, target.targetRevision, (value) => {
    value.proxyCycles[0].status = 'removed'; value.proxyCycles[0].endedAt = new Date().toISOString(); return value;
  });
  const first = structuredClone(target.proxyCycles[0]);
  target = await store.beginProxyCycle(target.targetId, target.targetRevision, 4, { ...parameters, remotePort: 17891 });
  assert.notEqual(target.currentCycleId, firstId);
  assert.deepEqual(target.proxyCycles[0], first);
  assert.equal(target.proxyCycles[1].forwarding.firstRecovery, null);
  await assert.rejects(store.updateTarget(target.targetId, target.targetRevision, (value) => {
    value.proxyCycles[0].outcome = 'rewritten'; return value;
  }), /已结束/);
});

test('v1/v2 迁移保留初始逆操作和未知暂存，不取得连接所有权，重复确认不创建新目标', async (t) => {
  for (const version of [1, 2]) {
    const { store, directory } = await storeFixture(t);
    const prepared = prepareEdits({ sshText: 'Host sample\n  HostName example.test\n', settingsText: null, host: 'sample', localPort: 7897, remotePort: 17890 });
    const base = { version, host: 'sample', sshConfig: connection.sshConfig, localProxy: 'http://127.0.0.1:7897', localPort: 7897,
      remotePort: 17890, remoteSettings: '/root/.vscode-server/data/Machine/settings.json', remoteMode: '600', listenerTool: 'proc',
      remoteStaging: '/root/.codex-proxy-e2e-old', phase: 'local-written' };
    const legacy = version === 2 ? { ...base, recovery: prepared.recovery } : { ...base,
      localOwned: prepared.recovery.ssh.owned, localSnippet: prepared.recovery.ssh.snippet,
      localBeforeHash: prepared.recovery.ssh.beforeHash, localAfterHash: prepared.recovery.ssh.afterHash,
      remoteOwned: prepared.recovery.settings.owned, remoteExisted: prepared.recovery.settings.existed,
      remoteBeforeHash: prepared.recovery.settings.beforeHash, remoteAfterHash: prepared.recovery.settings.afterHash,
      remoteInverseSteps: prepared.recovery.settings.inverseSteps };
    const file = path.join(directory, 'active.json');
    const text = JSON.stringify(legacy); await fs.writeFile(file, text);
    await assert.rejects(store.reconcile(), /确认迁移/);
    await assert.rejects(store.migrateLegacy({ expectedSourceHash: '0'.repeat(64), confirmedPreviewRevision: 1 }), /来源已变化/);
    assert.equal(await fs.readFile(file, 'utf8'), text);
    const target = await store.migrateLegacy({ expectedSourceHash: sha256(text), confirmedPreviewRevision: 1 });
    assert.equal(target.connectionResource.firstRecovery.owned, false);
    assert.equal(target.proxyCycles[0].forwarding.firstRecovery.beforeHash, prepared.recovery.ssh.beforeHash);
    assert.deepEqual(target.proxyCycles[0].settings.firstRecovery.inverseSteps, prepared.recovery.settings.inverseSteps);
    assert.equal(target.proxyCycles[0].settings.firstRecovery.existed, false);
    assert.equal(target.proxyCycles[0].settings.state, 'unknown');
    assert.equal(target.migration.remoteStaging, base.remoteStaging);
    const again = await store.migrateLegacy({ expectedSourceHash: sha256(text), confirmedPreviewRevision: 1 });
    assert.equal(again.targetId, target.targetId);
    assert.equal((await fs.readdir(path.join(directory, 'targets'))).length, 1);
    assert.equal((await store.readEntry()).value.version, 3);
  }
});

test('恶意或损坏旧逆操作不能迁移，旧记录和其余文件保持原样', async (t) => {
  const { store, directory } = await storeFixture(t);
  const file = path.join(directory, 'active.json');
  const malformed = JSON.stringify({ version: 2, host: 'sample', localProxy: 'http://127.0.0.1:7897', sshConfig: connection.sshConfig,
    remotePort: 17890, remoteSettings: '/root/settings.json', remoteMode: '600', listenerTool: 'proc', recovery: { ssh: { snippet: 'TEST_SECRET' } } });
  await fs.writeFile(file, malformed);
  await assert.rejects(store.migrateLegacy({ expectedSourceHash: sha256(malformed), confirmedPreviewRevision: 1 }), (error) => !error.message.includes('TEST_SECRET'));
  assert.equal(await fs.readFile(file, 'utf8'), malformed);
  assert.equal(await fs.stat(path.join(directory, 'targets')).catch(() => null), null);
});

test('新建每个元数据发布边界中断后仅收敛元数据，保持唯一目标', async (t) => {
  for (const boundary of [1, 2, 3]) {
    const { store, directory, instance } = await storeFixture(t);
    await store.initializeEntry();
    let writes = 0;
    const crashing = createStateStore(directory, instance, { afterSave: async () => {
      if (++writes === boundary) throw new Error('simulated interruption');
    } });
    await assert.rejects(crashing.createTarget({ expectedEntryRevision: 0, confirmedPreviewRevision: 1, connection }), /interruption/);
    await store.reconcile();
    const observed = await store.inspect();
    assert.equal(observed.targets.length, 1);
    assert.equal(observed.pending.length, 0);
    assert.equal(observed.entry.value.currentTargetId, observed.current.value.targetId);
    assert.equal(observed.current.value.connectionResource.state, 'untouched');
  }
});

test('两个独立进程竞争实例锁仅有一个胜者，失败者不删除胜者锁', async (t) => {
  const { directory, deps } = await fixture(t);
  const moduleUrl = new URL('../scripts/state.mjs', import.meta.url).href;
  const code = `import { acquireInstance } from ${JSON.stringify(moduleUrl)};
    let instance;
    process.on('message', async () => {
      if (instance) await instance.release();
      process.disconnect();
    });
    try {
      instance = await acquireInstance(process.argv[1], { restrictDirectory: async () => {} });
      process.send({ acquired: true, ownerId: instance.owner.ownerId });
    } catch {
      process.send({ acquired: false }); process.disconnect();
    }`;
  const children = [0, 1].map(() => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, directory], { shell: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const closed = new Promise((resolve) => child.once('close', resolve));
    const result = new Promise((resolve, reject) => {
      child.once('message', resolve); child.once('error', reject);
      child.once('exit', () => reject(new Error('fixture exited before result')));
    });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
    return { child, result, closed };
  });
  const results = await Promise.all(children.map((entry) => entry.result));
  assert.equal(results.filter((result) => result.acquired).length, 1);
  const winnerIndex = results.findIndex((result) => result.acquired);
  await children[1 - winnerIndex].closed;
  assert.equal((await readRecord(path.join(directory, 'instance.lock'))).value.ownerId, results[winnerIndex].ownerId);
  await assert.rejects(acquireInstance(directory, deps), /已有工作实例/);
  children[winnerIndex].child.send('release'); await children[winnerIndex].closed;
  const next = await acquireInstance(directory, deps); await next.release();
});
