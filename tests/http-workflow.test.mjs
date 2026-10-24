import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { acquireInstance, createStateStore } from '../scripts/state.mjs';
import { createAppServer } from '../app/server.mjs';

async function fixture(t, executeOperation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-http-v3-'));
  const instance = await acquireInstance(path.join(directory, 'state'), { restrictDirectory: async () => {} });
  const store = createStateStore(instance.directory, instance);
  const app = await createAppServer({ store, directory: instance.directory, executeOperation });
  t.after(async () => { await app.close(); await instance.release(); await fs.rm(directory, { recursive: true, force: true }); });
  const call = async (route, body) => {
    const response = await fetch(app.origin + route, { method: body ? 'POST' : 'GET', headers: { 'X-Codex-Session': app.token,
      ...(body ? { Origin: app.origin, 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { app, call, store };
}
const initialize = () => ({ requestId: randomUUID(), kind: 'initialize', options: { declaration: 'new-or-rebuilt', sshCommand: 'ssh -p 22 root@sample.test',
  sshConfig: path.resolve('sample-config'), localProxy: 'http://127.0.0.1:7897', remotePort: 17890 } });
async function until(app, predicate) {
  for (let i = 0; i < 300; i++) { if (predicate(app.snapshot())) return app.snapshot(); await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail('未进入预期状态');
}
const completed = (app) => until(app, (state) => ['failed', 'succeeded', 'cancelled', 'recovery-required'].includes(state.operation?.status));
const outcome = { outcome: 'needs-user', stage: 'server', checks: [], nextAction: 'prepare-server' };

test('共享操作异步等待精确问题，重复回答不重复推进，旧问题/revision 拒绝', async (t) => {
  let calls = 0, answers = 0;
  const { app, call } = await fixture(t, async (input, io) => {
    calls++; assert.equal(input.connection.hostname, 'sample.test');
    const answer = await io.confirm({ title: '精确预览', previewRevision: 1, expiresAt: Date.now() + 600_000, choices: ['confirm', 'cancel'], changes: ['tool delta'] });
    assert.equal(answer, 'confirm'); answers++; return outcome;
  });
  const request = initialize(), started = await call('/api/operations', request);
  assert.equal(started.status, 202); assert.deepEqual((await call('/api/operations', request)).body, started.body);
  const snapshot = await until(app, (state) => state.operation?.waitingQuestion);
  for (let i = 0; i < 3; i++) assert.equal((await call('/api/state')).status, 200);
  assert.equal(calls, 1); assert.equal(answers, 0);
  const question = snapshot.operation.waitingQuestion, route = `/api/operations/${started.body.operationId}/answer`;
  const answer = { requestId: randomUUID(), questionId: question.questionId, previewRevision: 1, choice: 'confirm' };
  assert.equal((await call(route, { ...answer, requestId: randomUUID(), previewRevision: 2 })).status, 409);
  assert.equal((await call(route, answer)).status, 200); assert.equal((await call(route, answer)).status, 200);
  assert.equal((await call(route, { ...answer, choice: 'cancel' })).status, 409);
  await completed(app); assert.equal(answers, 1);
  assert.equal((await call(route, { ...answer, requestId: randomUUID() })).status, 409);
  assert.equal(app.snapshot().operation.result.outcome, 'needs-user');
});

test('等待中取消会废弃问题；二次取消使用独立恢复 signal，不立刻放开 busy', async (t) => {
  let release, normalSignal, recoverySignal;
  const { app, call } = await fixture(t, async (_input, io, dependencies) => {
    normalSignal = dependencies.signal; recoverySignal = dependencies.recoverySignal;
    try { await io.waitForUser({ title: '等待', previewRevision: 1, expiresAt: null, choices: ['ready', 'later'] }); }
    catch { await new Promise((resolve) => { release = resolve; }); }
    return { ...outcome, outcome: 'recovery-required' };
  });
  const started = await call('/api/operations', initialize()); await until(app, (state) => state.operation.waitingQuestion);
  const route = `/api/operations/${started.body.operationId}/cancel`, request = { requestId: randomUUID() };
  assert.equal((await call(route, request)).status, 202); assert.equal(normalSignal.aborted, true); assert.equal(recoverySignal.aborted, false);
  assert.equal(app.snapshot().operation.status, 'cancelling'); assert.equal(app.snapshot().operation.waitingQuestion, null);
  assert.equal((await call('/api/operations', initialize())).status, 409);
  await call(route, request); assert.equal(recoverySignal.aborted, false); // 同 requestId 重试不是二次取消。
  await call(route, { requestId: randomUUID() }); assert.equal(recoverySignal.aborted, true);
  release(); await completed(app); assert.equal(app.snapshot().operation.status, 'recovery-required');
});

test('偏好 CAS 和去重；活动操作期间不保存，GET 无状态文件写入', async (t) => {
  const { app, call, store } = await fixture(t, async (_input, io) => {
    await io.confirm({ title: '等待', previewRevision: 1, expiresAt: null, choices: ['confirm', 'cancel'] }); return outcome;
  });
  assert.equal(await store.readEntry(), null); await call('/api/state'); assert.equal(await store.readEntry(), null);
  const body = { requestId: randomUUID(), expectedPreferencesRevision: null, preferences: { localProxy: 'http://localhost:7897/', remotePort: 17890 } };
  const saved = await call('/api/preferences', body); assert.equal(saved.status, 200); assert.equal(saved.body.preferences.revision, 0);
  assert.deepEqual((await call('/api/preferences', body)).body, saved.body);
  assert.equal((await call('/api/preferences', { ...body, requestId: randomUUID() })).status, 409);
  assert.equal((await call('/api/preferences', { ...body, preferences: { ...body.preferences, remotePort: 17891 } })).status, 409);
  await call('/api/operations', initialize()); await until(app, (state) => state.operation.waitingQuestion);
  assert.equal((await call('/api/preferences', { ...body, requestId: randomUUID(), expectedPreferencesRevision: 0 })).status, 409);
  assert.equal((await store.readPreferences()).value.revision, 0);
});

test('五种固定操作共享执行入口，任意通知/错误/完整配置不进入投影', async (t) => {
  const seen = [], secret = 'TEST_SECRET';
  const { app, call } = await fixture(t, async (input, io) => {
    seen.push(input.kind); io.notify({ status: 'running', message: secret, stderr: secret, stage: secret });
    return { ...outcome, error: secret, fullConfig: secret, target: { targetId: randomUUID(), alias: 'safe', fullConfig: secret } };
  });
  for (const kind of ['initialize', 'resume', 'verify', 'remove', 'abandon']) {
    const request = kind === 'initialize' ? initialize() : { requestId: randomUUID(), kind, options: {
      targetId: randomUUID(), expectedTargetRevision: 0, ...(kind !== 'abandon' ? { declaration: 'original-container' } : {}) } };
    assert.equal((await call('/api/operations', request)).status, 202); await completed(app);
    assert.ok(!JSON.stringify((await call('/api/state')).body).includes(secret));
  }
  assert.deepEqual(seen, ['initialize', 'resume', 'verify', 'remove', 'abandon']);
});
