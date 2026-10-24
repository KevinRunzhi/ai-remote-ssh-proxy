import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStateStore, defaultStateDirectory } from '../scripts/state.mjs';
import { runSsh, ExpectedError } from '../scripts/ssh.mjs';
import { sha256 } from '../scripts/config.mjs';
import { parseSshCommand, normalizeConnection, normalizeProxy, port, configPath } from '../scripts/input.mjs';
import { runOperation, normalizeOperationInput, operationKinds } from '../scripts/workflow.mjs';
import { projectQuestion, projectResult, projectStoredState } from './projection.mjs';
import { verifyBundle } from '../scripts/integrity.mjs';
import { acquireWorkingInstance } from '../scripts/instance-recovery.mjs';

const resources = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const READONLY_PROBE = "set -eu; printf '__CODEX_PROBE_READY__\\n'";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function fields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !names.includes(key))) {
    throw new HttpError(400, '请求字段不受支持。');
  }
}

function probeOptions(value) {
  fields(value, ['host', 'sshCommand', 'sshConfig']);
  try {
    if (value.sshCommand !== undefined) {
      if (value.host !== undefined) throw new ExpectedError('命令与 alias 不能同时填写。');
      const parsed = parseSshCommand(value.sshCommand);
      if (value.sshConfig !== undefined && value.sshConfig !== '') parsed.sshConfig = configPath(value.sshConfig);
      if (parsed.inputMode === 'alias' && !parsed.sshConfig) throw new ExpectedError('alias 模式需要确认 SSH config 路径。');
      return parsed;
    }
    if (typeof value.sshConfig !== 'string') throw new ExpectedError('请确认 SSH config 路径。');
    return normalizeConnection({ inputMode: 'alias', host: value.host, sshConfig: value.sshConfig });
  } catch (error) { throw new HttpError(400, error instanceof ExpectedError ? error.message : '连接字段无效。'); }
}

async function runProbe(options, signal, notify) {
  if (options.sshConfig) {
    const stat = await fs.lstat(options.sshConfig);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new ExpectedError('SSH config 不是受支持的普通文件。');
  }
  const stdout = await runSsh({ ...options, signal, notify }, READONLY_PROBE, [], 10_000, 'sh', '只读认证探针');
  if (stdout.replace(/\r/g, '') !== '__CODEX_PROBE_READY__\n') throw new ExpectedError('没有收到预期探针结果，不能确认成功。');
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new HttpError(400, '仅接受 JSON。');
  if (request.headers['content-encoding']) throw new HttpError(400, '不接受压缩请求。');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, '请求过大。');
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new HttpError(400, 'JSON 无效。'); }
}

export function createProbeServer(options = {}) { return createLocalServer({ ...options, probeOnly: true }); }
export function createAppServer(options) { return createLocalServer({ ...options, probeOnly: false }); }

async function createLocalServer({ executeProbe = runProbe, executeOperation = runOperation, onShutdown = () => {},
  probeOnly, store, directory, dependencies = {} } = {}) {
  if (!probeOnly && (!store || !directory)) throw new ExpectedError('业务页面缺少状态目录/实例。');
  const token = randomBytes(32).toString('base64url');
  const assets = new Map();
  for (const [url, [file, type]] of resources) assets.set(url, { body: await fs.readFile(new URL(`./public/${file}`, import.meta.url)), type });
  const requests = new Map();
  let operation = null;
  let controller = null;
  let recoveryController = null;
  let waiting = null;
  let mutating = false;
  let stored = null;
  let closePromise = null;
  let pending = Promise.resolve();
  let revision = 0;
  let stopping = false;
  let address;
  const refreshStored = async () => { if (!probeOnly) stored = projectStoredState(await store.inspect(), await store.readPreferences()); };
  try { await refreshStored(); } catch { stored = { issue: 'state-review-required', target: null, preferences: null }; }
  const busy = () => mutating || ['running', 'waiting-user', 'cancelling'].includes(operation?.status);
  const update = (data) => { operation = { ...operation, ...data }; revision++; };
  const snapshot = () => ({
    mode: probeOnly ? 'authentication-probe' : 'workspace', stateRevision: revision, stopping, stored,
    operation: operation && { ...operation },
    capabilities: probeOnly ? ['probe'] : stored?.issue ? stored.stateRecovery ? ['resume'] : [] : operationKinds,
    defaults: { sshConfig: path.join(os.homedir(), '.ssh', 'config') },
  });
  const reply = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  };
  const cancel = (repeat = false) => {
    if (operation && busy() && operation.status !== 'cancelling') {
      update({ status: 'cancelling', waitingQuestion: null, message: '正在结束当前操作并保存收尾结果。' });
      controller?.abort(); waiting?.reject(new ExpectedError('当前问题已取消。'));
    } else if (repeat && operation?.status === 'cancelling') recoveryController?.abort();
  };
  const ask = (question) => new Promise((resolve, reject) => {
    if (controller.signal.aborted) { reject(new ExpectedError('操作已取消。')); return; }
    if (waiting) { reject(new ExpectedError('已有等待问题。')); return; }
    const projected = projectQuestion(question);
    const questionId = randomUUID();
    let timer;
    const finish = (action, value) => { clearTimeout(timer); waiting = null; update({ waitingQuestion: null }); action(value); };
    waiting = { questionId, previewRevision: projected.previewRevision, choices: projected.choices,
      resolve: (value) => finish(resolve, value), reject: (error) => finish(reject, error) };
    if (projected.expiresAt !== null) timer = setTimeout(() => waiting?.questionId === questionId && waiting.reject(new ExpectedError('预览已过期。')), Math.max(0, projected.expiresAt - Date.now()));
    update({ status: 'waiting-user', waitingQuestion: { ...projected, questionId } });
  });
  const close = () => {
    if (closePromise) return closePromise;
    stopping = true; cancel(); revision++;
    closePromise = (async () => { await pending; await new Promise((resolve) => server.close(resolve)); await onShutdown(); })();
    return closePromise;
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      if (request.headers.host !== address.host) throw new HttpError(403, 'Host 不受允许。');
      if (request.method === 'GET' && assets.has(request.url)) {
        const asset = assets.get(request.url);
        response.writeHead(200, { 'Content-Type': asset.type }); response.end(asset.body); return;
      }
      const supplied = Buffer.from(request.headers['x-codex-session'] ?? '');
      const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new HttpError(403, '会话失效，请使用启动终端提供的本次地址。');
      if (request.headers.origin && request.headers.origin !== address.origin) throw new HttpError(403, 'Origin 不受允许。');
      if (request.method === 'GET' && request.url === '/api/state') { reply(response, 200, snapshot()); return; }
      if (request.method !== 'POST') throw new HttpError(404, '接口不存在。');
      if (request.headers.origin !== address.origin) throw new HttpError(403, '写请求必须同源。');
      const body = await readBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求必须是 JSON 对象。');
      if (typeof body.requestId !== 'string' || !UUID.test(body.requestId)) throw new HttpError(400, 'requestId 无效。');
      const route = request.url;
      const actionRoute = route.match(/^\/api\/operations\/([a-f0-9-]{36})\/(answer|cancel)$/);
      if (route !== '/api/operations' && route !== '/api/shutdown' && !(route === '/api/preferences' && !probeOnly) && !actionRoute) throw new HttpError(404, '接口不存在。');
      let options = null;
      if (route === '/api/operations') {
        fields(body, ['requestId', 'kind', 'options']);
        if (probeOnly) { if (body.kind !== 'probe') throw new HttpError(400, '探针模式只提供 probe。'); options = probeOptions(body.options); }
        else {
          try { fields(body.options, ['declaration', 'connection', 'sshCommand', 'localProxy', 'remotePort', 'sshConfig', 'codePath', 'targetId', 'expectedTargetRevision', 'reconfigure', 'pid', 'stateRecovery']);
            const { sshCommand, ...values } = body.options;
            if (sshCommand !== undefined && (body.kind !== 'initialize' || values.connection !== undefined)) throw new Error('连接重复。');
            options = normalizeOperationInput({ ...values, ...(sshCommand !== undefined ? { connection: parseSshCommand(sshCommand) } : {}), kind: body.kind });
          } catch { throw new HttpError(400, '操作字段无效，请检查目标声明、连接和端口。'); }
        }
      } else if (route === '/api/preferences') {
        fields(body, ['requestId', 'expectedPreferencesRevision', 'preferences']);
        fields(body.preferences, ['localProxy', 'remotePort', 'sshConfig', 'codePath']);
        if (!(body.expectedPreferencesRevision === null || Number.isSafeInteger(body.expectedPreferencesRevision) && body.expectedPreferencesRevision >= 0)) throw new HttpError(400, '偏好 revision 无效。');
        try { options = { localProxy: normalizeProxy(body.preferences.localProxy).localProxy, remotePort: port(body.preferences.remotePort),
          ...(body.preferences.sshConfig !== undefined ? { sshConfig: configPath(body.preferences.sshConfig) } : {}), ...(body.preferences.codePath !== undefined ? { codePath: configPath(body.preferences.codePath) } : {}) }; }
        catch { throw new HttpError(400, '偏好字段无效。'); }
      } else if (actionRoute?.[2] === 'answer') {
        fields(body, ['requestId', 'questionId', 'previewRevision', 'choice']);
        if (probeOnly || typeof body.questionId !== 'string' || !UUID.test(body.questionId) || !Number.isSafeInteger(body.previewRevision) || typeof body.choice !== 'string') throw new HttpError(400, '问题回答无效。');
      } else fields(body, ['requestId']);
      const digest = sha256(JSON.stringify({ route, kind: body.kind, options, questionId: body.questionId, previewRevision: body.previewRevision,
        choice: body.choice, expectedPreferencesRevision: body.expectedPreferencesRevision }));
      const previous = requests.get(body.requestId);
      if (previous) {
        if (previous.digest !== digest) throw new HttpError(409, 'requestId 已用于不同请求。');
        const original = previous.promise ? await previous.promise : previous;
        reply(response, original.status, original.body); return;
      }
      if (requests.size >= 512) throw new HttpError(409, '本次会话请求已满，请安全退出后重启。');
      let result, status = 202;
      if (route === '/api/operations') {
        if (busy() || stopping) throw new HttpError(409, '当前操作尚未结束。');
        if (!probeOnly && stored?.issue && !(stored.stateRecovery && options.stateRecovery)) throw new HttpError(409, '状态需要受控核对，未启动写入。');
        controller = new AbortController();
        recoveryController = new AbortController();
        update({ operationId: randomUUID(), kind: body.kind, status: 'running', stage: 'state', checks: [], waitingQuestion: null, result: null,
          message: '正在执行；需要认证时请切换到启动终端。' });
        const currentId = operation.operationId;
        // 排入微任务；先登记 busy 和去重结果，再执行任何外部操作。
        const notify = (event) => {
          if (operation.operationId !== currentId || operation.status === 'cancelling') return;
          // 传输通知只接收固定状态；不转发任意 message/stdout/stderr。
          const stages = ['state', 'local-preflight', 'remote-preflight', 'reconcile', 'connection', 'forwarding', 'server', 'settings', 'codex', 'verify', 'remove', 'abandon'];
          const projected = {};
          if (stages.includes(event.stage)) projected.stage = event.stage;
          if (['waiting-user', 'running'].includes(event.status)) projected.status = event.status;
          if (Object.keys(projected).length) update(projected);
        };
        pending = Promise.resolve().then(() => probeOnly ? executeProbe(options, controller.signal, notify)
          : executeOperation(options, { notify, confirm: ask, waitForUser: ask }, { ...dependencies, store, directory, operationId: currentId,
            signal: controller.signal, recoverySignal: recoveryController.signal })).then(async (value) => {
          if (!probeOnly) {
            const result = projectResult(value);
            await refreshStored();
            update({ status: result.outcome === 'recovery-required' ? 'recovery-required' : controller.signal.aborted ? 'cancelled'
              : ['failed', 'cancelled'].includes(result.outcome) ? result.outcome : 'succeeded', result, checks: result.checks, waitingQuestion: null,
              message: result.outcome === 'succeeded' ? '本次操作完成；请查看业务结果与下一步。' : result.outcome === 'needs-user' ? '初始化尚未完成，请按下一步继续。' : '当前阶段未完成，请检查结果后继续或恢复。' }); return;
          }
          update(controller.signal.aborted
            ? { status: 'cancelled', message: '只读探针已取消，子进程已结束。' }
            : { status: 'succeeded', message: '只读 SSH 探针通过；尚未配置代理或安装 Codex。' });
        }).catch(async () => {
          try { await refreshStored(); } catch { stored = { ...stored, issue: 'state-review-required' }; }
          update(controller.signal.aborted
            ? { status: 'cancelled', waitingQuestion: null, message: probeOnly ? '只读探针已取消，子进程已结束。' : '本次操作已取消；请查看保留的阶段和恢复状态。' }
            : { status: 'failed', waitingQuestion: null, message: probeOnly ? '只读探针失败；查看原生终端的 OpenSSH 提示，不会修改配置。' : '操作未能安全完成；保留记录，原始错误未展示。' });
        });
        result = { operationId: currentId };
      } else if (route === '/api/preferences') {
        if (busy() || stopping) throw new HttpError(409, '当前操作尚未结束。');
        if ((stored?.preferences?.revision ?? null) !== body.expectedPreferencesRevision) throw new HttpError(409, '偏好 revision 已变化。');
        mutating = true;
        const saving = (async () => {
          try { await store.savePreferences({ expectedRevision: body.expectedPreferencesRevision, values: options }); await refreshStored(); revision++;
            return { status: 200, body: { preferences: stored.preferences } };
          } catch { return { status: 409, body: { error: '偏好未能保存；原配置未被业务操作替换。' } }; }
          finally { mutating = false; }
        })();
        requests.set(body.requestId, { digest, promise: saving }); pending = saving;
        const saved = await saving; reply(response, saved.status, saved.body); return;
      } else if (actionRoute) {
        if (actionRoute[1] !== operation?.operationId) throw new HttpError(404, '操作不存在。');
        if (actionRoute[2] === 'cancel') { cancel(true); result = { operationId: operation.operationId }; }
        else {
          if (stopping || operation.status !== 'waiting-user' || !waiting || waiting.questionId !== body.questionId
              || waiting.previewRevision !== body.previewRevision || !waiting.choices.includes(body.choice)) throw new HttpError(409, '问题已过期或回答与当前预览不符。');
          waiting.resolve(body.choice); update({ status: 'running' }); result = { accepted: true }; status = 200;
        }
      }
      else {
        stopping = true; revision++; cancel(); result = { stopping: true };
        pending.finally(() => { setImmediate(() => { close().catch(() => { process.exitCode = 1; }); }); });
      }
      requests.set(body.requestId, { digest, status, body: result });
      reply(response, status, result);
    } catch (error) {
      if (!response.headersSent) reply(response, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : '操作未能安全处理；原始错误未展示。' });
      else response.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 40;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const listenPort = server.address().port;
  address = { host: `127.0.0.1:${listenPort}`, origin: `http://127.0.0.1:${listenPort}` };
  return {
    ...address, token, url: `${address.origin}/#${token}`, snapshot,
    close,
  };
}

export async function startProbe({ probeOnly = false } = {}) {
  await verifyBundle();
  if (process.platform !== 'win32' || !process.stdin.isTTY || !process.stderr.isTTY) throw new ExpectedError('请在 Windows 原生交互终端中双击 start.cmd；当前终端不能承担密码认证。');
  const lock = await acquireWorkingInstance(defaultStateDirectory());
  let app;
  try {
    const store = createStateStore(lock.directory, lock);
    app = await (probeOnly ? createProbeServer : createAppServer)({ store, directory: lock.directory, onShutdown: async () => { await lock.release(); console.log('工具已收尾退出；未知结果仍保存在恢复记录中。'); } });
    console.log(probeOnly ? 'v0.3 只读认证探针。密码只在此终端输入。' : 'v0.3 开发候选：请先在页面核对预览；尚未完成首次安装与交付验收。密码只在此终端输入。');
    console.log(`请在浏览器打开本次地址（不要分享）：${app.url}`);
    console.log(`默认 SSH config：${path.join(os.homedir(), '.ssh', 'config')}`);
    // explorer 只接收程序自己生成的回环 URL；不经 cmd /c 或 shell。
    const { spawn } = await import('node:child_process');
    const browser = spawn(path.join(process.env.WINDIR, 'explorer.exe'), [app.url], { shell: false, windowsHide: true, stdio: 'ignore' });
    browser.on('error', () => console.log('浏览器未自动打开，请使用上方本次地址。'));
    let closing = false;
    const close = async () => { if (closing) return; closing = true; await app.close(); await lock.release(); };
    process.on('SIGINT', () => { close().catch(() => { process.exitCode = 1; }); });
    process.on('SIGTERM', () => { close().catch(() => { process.exitCode = 1; }); });
    return app;
  } catch (error) { if (app) await app.close(); await lock.release(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await startProbe(); }
  catch (error) { console.error(error instanceof ExpectedError ? error.message : '启动失败；未展示原始错误。'); process.exitCode = 1; }
}
