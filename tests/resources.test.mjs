import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { acquireInstance, createStateStore } from '../scripts/state.mjs';
import { createResourceOperations } from '../scripts/resources.mjs';
import { writeLocalPlan } from '../scripts/local-config.mjs';
import { contentSnapshot, planConnection, planForwarding, planSettings, planResourceRestore } from '../scripts/config.mjs';

async function fixture(t, dependencies = {}, stateDependencies = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-resource-test-'));
  const instance = await acquireInstance(path.join(directory, 'state'), { restrictDirectory: async () => {} });
  t.after(async () => { await instance.release(); await fs.rm(directory, { force: true, recursive: true }); });
  const store = createStateStore(instance.directory, instance, stateDependencies);
  await store.initializeEntry();
  const file = path.join(directory, 'config');
  let target = await store.createTarget({ expectedEntryRevision: 0, confirmedPreviewRevision: 1,
    connection: { alias: 'sample', hostname: 'example.test', username: 'root', sshPort: 22, sshConfig: file } });
  target = await store.beginProxyCycle(target.targetId, target.targetRevision, 2, { localProxy: 'http://127.0.0.1:7897', remotePort: 17890 });
  const operations = createResourceOperations({ store, directory: instance.directory, dependencies: { restrictDirectory: async () => {}, ...dependencies } });
  const current = async () => (await store.readTarget(target.targetId)).value;
  const commit = async (kind, plan, extra = {}) => operations.commit({ targetId: target.targetId, expectedTargetRevision: (await current()).targetRevision,
    cycleId: kind === 'connection' ? null : target.currentCycleId, kind, plan, operationId: randomUUID(), confirmedPreviewRevision: 3, ...extra });
  return { directory, store, operations, file, current, commit, target };
}
const connection = (f) => planConnection({ sshText: null, filePath: f.file, alias: 'sample', hostname: 'example.test', username: 'root', targetId: f.target.targetId });

test('本机三资源意图预存，失败只收尾当前转发，移除保留已完成连接', async (t) => {
  let f, failForward = true;
  f = await fixture(t, { writeLocalPlan: async (plan, lease, options) => {
    const resource = plan.kind === 'connection' ? (await f.current()).connectionResource : (await f.current()).proxyCycles[0].forwarding;
    assert.equal(resource.state, 'intended'); assert.equal(resource.pendingWrite.expectedAfter.sha256, plan.expectedAfter.sha256);
    assert.ok(resource.firstRecovery); assert.ok(resource.pendingWrite.stageRef.directory);
    if (plan.kind === 'forwarding' && failForward) throw new Error('TEST_SECRET');
    return writeLocalPlan(plan, lease, options);
  } });
  const connected = connection(f); assert.equal((await f.commit('connection', connected)).outcome, 'succeeded');
  const forward = planForwarding({ sshText: connected.text, filePath: f.file, alias: 'sample', localPort: 7897, remotePort: 17890,
    targetId: f.target.targetId, cycleId: f.target.currentCycleId });
  assert.equal((await f.commit('forwarding', forward)).outcome, 'not-applied');
  assert.equal(await fs.readFile(f.file, 'utf8'), connected.text);
  assert.equal((await f.current()).connectionResource.state, 'applied');
  failForward = false; assert.equal((await f.commit('forwarding', forward)).outcome, 'succeeded');
  const initialRecovery = structuredClone((await f.current()).proxyCycles[0].forwarding.firstRecovery);
  const restore = planResourceRestore({ kind: 'forwarding', text: forward.text, filePath: f.file, firstRecovery: initialRecovery });
  assert.equal((await f.commit('forwarding', restore, { action: 'restore' })).outcome, 'succeeded');
  const target = await f.current();
  assert.equal(target.proxyCycles[0].forwarding.state, 'reverted'); assert.equal(target.proxyCycles[0].forwarding.pendingWrite, null);
  assert.deepEqual(target.proxyCycles[0].forwarding.firstRecovery, initialRecovery);
  assert.equal(await fs.readFile(f.file, 'utf8'), connected.text);
  assert.ok(!JSON.stringify(target).includes('TEST_SECRET'));
});

test('本机写入完成但调用方丢失结果：复读补记，不再次写入', async (t) => {
  let count = 0;
  const f = await fixture(t, { writeLocalPlan: async (...args) => { count++; await writeLocalPlan(...args); throw new Error('lost receipt'); } });
  const result = await f.commit('connection', connection(f));
  assert.equal(result.outcome, 'succeeded'); assert.equal(result.interrupted, true); assert.equal(count, 1);
  assert.equal((await f.current()).connectionResource.state, 'applied');
  assert.equal((await f.current()).connectionResource.pendingWrite, null);
});

test('用户第三种状态保留 unknown 与意图，拒绝再次提交', async (t) => {
  let f;
  f = await fixture(t, { writeLocalPlan: async (plan) => { await fs.writeFile(plan.path, 'user-change'); throw new Error('unknown'); } });
  const plan = connection(f);
  assert.equal((await f.commit('connection', plan)).outcome, 'recovery-required');
  const resource = (await f.current()).connectionResource;
  assert.equal(resource.state, 'unknown'); assert.ok(resource.pendingWrite); assert.ok(resource.firstRecovery);
  await assert.rejects(f.commit('connection', plan), /未完成写入/);
  assert.equal(await fs.readFile(f.file, 'utf8'), 'user-change');
});

test('旧 revision、错误周期、确认后改动均在意图和写入前拒绝', async (t) => {
  const f = await fixture(t), plan = connection(f);
  await assert.rejects(f.commit('connection', plan, { expectedTargetRevision: 999 }), /revision/);
  await assert.rejects(f.commit('forwarding', { ...plan, kind: 'forwarding' }, { cycleId: randomUUID() }), /周期/);
  await fs.writeFile(f.file, 'keep'); await assert.rejects(f.commit('connection', plan), /确认后配置已变化/);
  assert.equal((await f.current()).connectionResource.firstRecovery, null);
  assert.equal(await fs.readFile(f.file, 'utf8'), 'keep');
});

test('远端回执丢失使用新 signal 先撤销许可再补记；清理独立且不持久保存完整配置', async (t) => {
  let f, remote = '{"private":"TEST_SECRET"}\n', writes = 0, closed = false;
  const controller = new AbortController();
  const original = remote;
  const deps = {
    remoteRead: async () => ({ text: remote }),
    runScp: async (options, file) => { remote = await fs.readFile(file, 'utf8'); },
    runRemoteProtocol: async (options, verb, protocol) => {
      const resource = (await f.current()).proxyCycles[0].settings;
      assert.ok(resource.pendingWrite); assert.equal(resource.pendingWrite.writeId, protocol.writeId);
      if (verb === 'allocate') return { status: 'allocated', permit: 'open', snapshot: null };
      if (verb === 'write') { writes++; controller.abort(); throw new Error('TEST_SECRET'); }
      if (verb === 'reconcile') {
        assert.notEqual(options.signal, controller.signal); assert.equal(options.signal.aborted, false); closed = true;
        return { status: 'reconciled', permit: 'closed', snapshot: contentSnapshot(remote) };
      }
      assert.equal(verb, 'cleanup'); assert.equal(closed, true); assert.equal(resource.pendingWrite.permit, 'closed');
      return { status: 'cleaned', permit: 'closed', snapshot: null };
    },
  };
  f = await fixture(t, deps);
  const plan = planSettings({ settingsText: original, filePath: '/root/Machine/settings.json', remotePort: 17890 });
  const result = await f.commit('settings', plan, { stageParent: '/root', signal: controller.signal });
  assert.equal(result.outcome, 'succeeded'); assert.equal(writes, 1);
  const target = await f.current(); assert.equal(target.proxyCycles[0].settings.pendingWrite, null);
  assert.equal(target.proxyCycles[0].settings.state, 'applied'); assert.ok(!JSON.stringify(target).includes('TEST_SECRET'));
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'state')), ['active.json', 'instance.lock', 'targets']);
});

test('远端 guard 未结束时不恢复、不删除暂存；重启后仍保留阻塞', async (t) => {
  let f, writes = 0, cleanups = 0;
  f = await fixture(t, {
    remoteRead: async () => ({ text: null }), runScp: async () => {},
    runRemoteProtocol: async (options, verb) => {
      if (verb === 'allocate') return { status: 'allocated', permit: 'open', snapshot: null };
      if (verb === 'write') { writes++; throw new Error('lost connection'); }
      if (verb === 'cleanup') cleanups++;
      return { status: 'unknown', permit: 'unknown', snapshot: null };
    },
  });
  const plan = planSettings({ settingsText: null, filePath: '/root/Machine/settings.json', remotePort: 17890 });
  assert.equal((await f.commit('settings', plan, { stageParent: '/root' })).outcome, 'recovery-required');
  const target = await f.current(); const resource = target.proxyCycles[0].settings;
  assert.equal(resource.state, 'unknown'); assert.ok(resource.pendingWrite.stageRef.directory);
  await assert.rejects(f.commit('settings', plan, { stageParent: '/root' }), /未完成写入/);
  assert.equal(writes, 1); assert.equal(cleanups, 0);
});
