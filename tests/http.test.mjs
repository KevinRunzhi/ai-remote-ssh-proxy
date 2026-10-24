import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createProbeServer } from '../app/server.mjs';

async function fixture(t, executeProbe = async () => {}) {
  const app = await createProbeServer({ executeProbe });
  t.after(() => app.close());
  const call = async (route, data, extra = {}) => {
    const result = await fetch(`${app.origin}${route}`, {
      method: data ? 'POST' : 'GET',
      headers: { 'X-Codex-Session': app.token, ...(data ? { 'Content-Type': 'application/json', Origin: app.origin } : {}), ...extra },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: result.status, headers: result.headers, body: await result.json() };
  };
  return { app, call };
}
const request = () => ({ requestId: randomUUID(), kind: 'probe', options: { host: 'test-target', sshConfig: `${process.cwd()}/test-config` } });
async function settled(app) {
  for (let i = 0; i < 200; i++) {
    if (['failed', 'succeeded', 'cancelled'].includes(app.snapshot().operation?.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('操作未及时进入终态');
}

test('探针 GET 状态无执行副作用，静态资源带 CSP 且不含 token', async (t) => {
  let calls = 0;
  const { app, call } = await fixture(t, async () => { calls++; });
  for (let i = 0; i < 3; i++) assert.equal((await call('/api/state')).status, 200);
  const page = await fetch(app.origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.ok(!(await page.text()).includes(app.token));
  assert.equal(calls, 0);
});

test('Token、Host、Origin、跨站预检和任意文件均受限', async (t) => {
  const { app, call } = await fixture(t);
  assert.equal((await call('/api/state', null, { 'X-Codex-Session': '' })).status, 403);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${app.origin}/api/state`, { headers: { Host: 'evil.example', 'X-Codex-Session': app.token } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await call('/api/state', null, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/api/operations', request(), { Origin: 'https://evil.example' })).status, 403);
  const preflight = await fetch(`${app.origin}/api/operations`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  assert.equal((await call('/scripts/e2e.mjs')).status, 404);
  assert.equal((await call('/api/operations')).status, 404);
});

test('同时/重复提交只有一个探针，相同 id 不同内容拒绝', async (t) => {
  let calls = 0;
  let release;
  const { app, call } = await fixture(t, async () => { calls++; await new Promise((resolve) => { release = resolve; }); });
  t.after(() => release?.());
  const body = request();
  const a = await call('/api/operations', body);
  const duplicate = await call('/api/operations', body);
  assert.equal(a.status, 202);
  assert.deepEqual(duplicate.body, a.body);
  assert.equal(calls, 1);
  assert.equal((await call('/api/operations', { ...body, options: { ...body.options, host: 'another' } })).status, 409);
  assert.equal((await call('/api/operations', request())).status, 409);
  assert.equal((await call('/api/state')).body.operation.status, 'running');
  release(); await settled(app);
  assert.equal(app.snapshot().operation.status, 'succeeded');
});

test('取消等原任务结束，等待期间不可启动另一个探针', async (t) => {
  let release;
  const { app, call } = await fixture(t, async (_options, signal) => {
    await new Promise((resolve) => { release = resolve; signal.addEventListener('abort', () => {}); });
  });
  t.after(() => release?.());
  const started = await call('/api/operations', request());
  const cancelPath = `/api/operations/${started.body.operationId}/cancel`;
  const cancelBody = { requestId: randomUUID() };
  assert.equal((await call(cancelPath, cancelBody)).status, 202);
  assert.equal(app.snapshot().operation.status, 'cancelling');
  assert.equal((await call(cancelPath, cancelBody)).status, 202);
  assert.equal((await call('/api/operations', request())).status, 409);
  release(); await settled(app);
  assert.equal(app.snapshot().operation.status, 'cancelled');
});

test('错误、原始通知与测试秘密不会进入状态响应', async (t) => {
  const secret = 'TEST_SECRET_NEVER_PROJECT';
  const { app, call } = await fixture(t, async (_options, _signal, notify) => {
    notify({ status: 'running', message: secret, stderr: secret });
    throw new Error(secret);
  });
  await call('/api/operations', request()); await settled(app);
  const state = await call('/api/state');
  assert.equal(state.body.operation.status, 'failed');
  assert.ok(!JSON.stringify(state.body).includes(secret));
});

test('拒绝命令、未知业务、非字符串标识和额外字段', async (t) => {
  let called = false;
  const { call } = await fixture(t, async () => { called = true; });
  for (const body of [
    { ...request(), kind: 'initialize' },
    { ...request(), extra: 'ignored?' },
    { ...request(), options: { host: '-oProxyCommand=bad', sshConfig: process.cwd() } },
    { ...request(), options: { host: 'valid', sshConfig: 'relative' } },
    { ...request(), requestId: [randomUUID()] },
  ]) assert.equal((await call('/api/operations', body)).status, 400);
  assert.equal(called, false);
});

test('超大正文返回 413，不启动操作', async (t) => {
  const { app } = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ ...request(), padding: 'x'.repeat(70_000) });
    const req = http.request(`${app.origin}/api/operations`, { method: 'POST', headers: {
      Host: app.host, Origin: app.origin, 'X-Codex-Session': app.token,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(body);
  });
  assert.equal(status, 413);
  assert.equal(app.snapshot().operation, null);
});

test('安全退出先等待只读探针收尾', async (t) => {
  let stopped = false;
  let release;
  const app = await createProbeServer({ onShutdown: () => { stopped = true; }, executeProbe: async () => {
    await new Promise((resolve) => { release = resolve; });
  } });
  t.after(() => { release?.(); return app.close(); });
  const post = (route, body) => fetch(`${app.origin}${route}`, { method: 'POST', headers: { Origin: app.origin, 'X-Codex-Session': app.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/operations', request())).status, 202);
  assert.equal((await post('/api/shutdown', { requestId: randomUUID() })).status, 202);
  assert.equal(stopped, false);
  assert.equal(app.snapshot().operation.status, 'cancelling');
  release(); await settled(app);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, true);
});
