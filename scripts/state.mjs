import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExpectedError, runProcess } from './ssh.mjs';
import { sha256, restrictWindowsDirectory } from './config.mjs';
import { normalizeProxy, normalizeConnection, port, configPath } from './input.mjs';
import { legacyContents } from './legacy-state.mjs';
import { planRemoteWrite } from './remote-protocol.mjs';

const MAX_RECORD = 1024 * 1024;
let processStart;
async function processStartedAt() {
  if (process.platform !== 'win32') return new Date(Date.now() - process.uptime() * 1000).toISOString();
  processStart ??= (async () => {
    if (!process.env.WINDIR) throw new ExpectedError('无法核对 Windows 进程启动身份。');
    const executable = path.join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = await runProcess({ executable, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; (Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToString('o')`], timeoutMs: 20_000, maxOutputBytes: 1024 });
    const value = result.stdout.trim();
    if (result.exitCode !== 0 || result.timedOut || result.outputExceeded || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new ExpectedError('无法核对 Windows 进程启动身份。');
    return value;
  })();
  return processStart;
}
export function defaultStateDirectory() {
  if (!process.env.LOCALAPPDATA) throw new ExpectedError('缺少 LOCALAPPDATA，无法保存状态。');
  return path.join(process.env.LOCALAPPDATA, 'codex-remote-ssh-proxy-e2e');
}

// 每级 lstat；拒绝目录链接，不能只检查最终文件。
export async function assertPlainDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new ExpectedError('状态目录必须是绝对路径。');
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ExpectedError('拒绝链接或非普通目录。');
  }
}

async function ensureDirectory(directory) {
  const parent = path.dirname(directory);
  await assertPlainDirectory(parent);
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await assertPlainDirectory(directory);
}

export async function readRecord(file) {
  await assertPlainDirectory(path.dirname(file));
  let stat;
  try { stat = await fs.lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD) throw new ExpectedError('状态文件类型或大小不受支持。');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > MAX_RECORD) throw new ExpectedError('状态文件已变化。');
    const bytes = Buffer.alloc(MAX_RECORD + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const next = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!next.bytesRead) break;
      bytesRead += next.bytesRead;
    }
    if (bytesRead > MAX_RECORD) throw new ExpectedError('状态文件过大。');
    const buffer = bytes.subarray(0, bytesRead);
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
    catch { throw new ExpectedError('状态文件损坏；保留原件，停止写入。'); }
    return { value, hash: sha256(buffer) };
  } finally { await handle.close(); }
}

export async function acquireInstance(directory, dependencies = {}) {
  await ensureDirectory(directory);
  const recoveryFile = path.join(directory, 'recovery-active.json');
  const checkRecovery = async () => {
    const recovery = await readRecord(recoveryFile);
    if (recovery && recovery.value.ownerId !== dependencies.recoveryOwnerId) {
      const error = new ExpectedError('已有锁恢复入口或待核对恢复记录；正常工作流尚未启动。');
      error.code = 'INSTANCE_EXISTS'; throw error;
    }
  };
  await checkRecovery();
  if (!dependencies.recoveryOwnerId && await readRecord(path.join(directory, 'operation.lock'))
      && !await readRecord(path.join(directory, 'instance.lock'))) {
    const error = new ExpectedError('发现无实例归属的写入锁，需要受控核对。'); error.code = 'INSTANCE_EXISTS'; throw error;
  }
  const restrict = dependencies.restrictDirectory ?? (async (dir) => {
    if (process.platform === 'win32') await restrictWindowsDirectory(dir, { runProcess });
    else await fs.chmod(dir, 0o700);
  });
  await restrict(directory);
  const file = path.join(directory, 'instance.lock');
  const owner = {
    version: 1, ownerId: randomUUID(), pid: process.pid,
    processStartedAt: await processStartedAt(),
  };
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') { const failure = new ExpectedError('已有工作实例或待核对遗留锁；请使用原窗口。不会按 PID 或超时自动接管。'); failure.code = 'INSTANCE_EXISTS'; throw failure; }
    throw error;
  }
  const identity = await handle.stat({ bigint: true });
  try { await handle.writeFile(`${JSON.stringify(owner)}\n`); await handle.sync(); await checkRecovery(); }
  catch (error) {
    await handle.close();
    const current = await fs.lstat(file, { bigint: true }).catch(() => null);
    if (current?.ino === identity.ino && current?.dev === identity.dev) await fs.unlink(file);
    throw error;
  }
  await handle.close();
  let released = false;
  let releasePromise = null;
  let writing = false;
  const assertOwner = async () => {
    if (released) throw new ExpectedError('工作实例已释放。');
    const current = await readRecord(file);
    if (!current || current.value.ownerId !== owner.ownerId) throw new ExpectedError('工作实例锁归属变化，未删除。');
  };
  return {
    owner,
    directory: path.resolve(directory),
    async withWriteLock(action) {
      await assertOwner();
      if (releasePromise) throw new ExpectedError('工作实例正在退出。');
      if (writing) throw new ExpectedError('当前实例已有写入操作。');
      writing = true;
      const writePath = path.join(directory, 'operation.lock');
      const writeOwner = { ownerId: owner.ownerId, writeId: randomUUID(), pid: owner.pid };
      let writeHandle;
      try {
        try { writeHandle = await fs.open(writePath, 'wx', 0o600); }
        catch (error) { if (error.code === 'EEXIST') throw new ExpectedError('已有写入操作或待核对的旧版锁；未接管。'); throw error; }
        await writeHandle.writeFile(`${JSON.stringify(writeOwner)}\n`); await writeHandle.sync();
        await assertOwner();
        const lease = { assertOwned: async () => {
          await assertOwner();
          const current = await readRecord(writePath);
          if (current?.value.writeId !== writeOwner.writeId || current.value.ownerId !== owner.ownerId) stop('写入锁归属变化，停止配置写入。');
        } };
        return await action(lease);
      } finally {
        if (writeHandle) {
          const identity = await writeHandle.stat({ bigint: true });
          await writeHandle.close();
          const current = await fs.lstat(writePath, { bigint: true }).catch(() => null);
          if (current?.ino === identity.ino && current?.dev === identity.dev) {
            const record = await readRecord(writePath).catch(() => null);
            if (record?.value.writeId === writeOwner.writeId) await fs.unlink(writePath);
          }
        }
        writing = false;
      }
    },
    release() {
      if (released) return Promise.resolve();
      if (releasePromise) return releasePromise;
      if (writing) return Promise.reject(new ExpectedError('写入尚未收尾，不能释放工作实例。'));
      releasePromise = (async () => {
        await assertOwner();
        await fs.unlink(file);
        released = true;
      })().catch((error) => { releasePromise = null; throw error; });
      return releasePromise;
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function isId(value) { return typeof value === 'string' && UUID.test(value); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function stop(message) { throw new ExpectedError(message); }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function preferencesValues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !['localProxy', 'remotePort', 'sshConfig', 'codePath'].includes(key))) stop('偏好字段不受支持；不保存容器或恢复信息。');
  const { localProxy } = normalizeProxy(value.localProxy);
  return { localProxy, remotePort: port(value.remotePort),
    ...(value.sshConfig !== undefined ? { sshConfig: configPath(value.sshConfig) } : {}),
    ...(value.codePath !== undefined ? { codePath: configPath(value.codePath) } : {}) };
}
function objectFields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) stop('状态含未知 schema 字段；保留原件。');
}
function validSnapshot(snapshot) {
  objectFields(snapshot, ['exists', 'sha256']);
  if (typeof snapshot.exists !== 'boolean' || (snapshot.exists ? typeof snapshot.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.sha256) : snapshot.sha256 !== null)) stop('资源摘要无效。');
}
function linuxPath(value) {
  return typeof value === 'string' && value.startsWith('/') && value !== '/' && !/[\x00-\x1f\x7f]/.test(value)
    && path.posix.normalize(value) === value && !value.endsWith('/');
}
function validRecovery(recovery, kind, legacy) {
  if (recovery === null) return;
  if (kind === 'connection' && legacy && recovery?.owned === false && recovery.reason === 'legacy-existing-alias') {
    objectFields(recovery, ['owned', 'reason']); return;
  }
  objectFields(recovery, kind === 'settings' ? ['owned', 'existed', 'properties', 'inverseSteps', 'beforeHash', 'afterHash'] : ['owned', 'existed', 'snippet', 'beforeHash', 'afterHash']);
  if (typeof recovery.owned !== 'boolean' || typeof recovery.existed !== 'boolean'
      || typeof recovery.afterHash !== 'string' || !/^[a-f0-9]{64}$/.test(recovery.afterHash)
      || !(recovery.existed ? typeof recovery.beforeHash === 'string' && /^[a-f0-9]{64}$/.test(recovery.beforeHash)
        : recovery.beforeHash === null || legacy && recovery.beforeHash === 'missing')) stop('资源恢复依据无效。');
  if (kind !== 'settings') {
    if (typeof recovery.snippet !== 'string' || !recovery.owned && recovery.snippet !== '' || recovery.owned && !recovery.snippet) stop('连接/转发恢复片段无效。');
  } else {
    objectFields(recovery.properties, ['http.proxy', 'http.useLocalProxyConfiguration']);
    for (const entry of Object.values(recovery.properties)) {
      objectFields(entry, ['owned', 'original']);
      if (typeof entry.owned !== 'boolean' || entry.original !== (entry.owned ? 'missing' : 'equivalent')) stop('代理字段恢复依据无效。');
    }
    if (!Array.isArray(recovery.inverseSteps) || recovery.inverseSteps.length > 2) stop('恢复逆操作无效。');
    for (const step of recovery.inverseSteps) {
      objectFields(step, ['offset', 'length', 'content']);
      if (!integer(step.offset) || !integer(step.length) || !step.length || step.offset + step.length > MAX_RECORD || step.content !== '') stop('恢复逆操作无效；不允许配置正文。');
    }
  }
}
function validResource(resource, kind, target, directory) {
  objectFields(resource, ['state', 'path', 'firstRecovery', 'pendingWrite', 'lastOutcome']);
  if (!resource || !['untouched', 'intended', 'applied', 'reused', 'reverted', 'unknown'].includes(resource.state)
      || !Object.hasOwn(resource, 'firstRecovery') || !Object.hasOwn(resource, 'pendingWrite')) stop('资源状态无效。');
  if (kind === 'settings' ? resource.path !== null && !linuxPath(resource.path) : resource.path !== target.connection.sshConfig) stop('资源路径与目标不一致。');
  validRecovery(resource.firstRecovery, kind, !!target.migration);
  if (resource.lastOutcome !== null && resource.lastOutcome !== undefined) {
    objectFields(resource.lastOutcome, ['status', 'action', 'writeId', 'localWriterClosed']);
    const outcome = resource.lastOutcome;
    if (!['conflict', 'occurred', 'not-occurred'].includes(outcome.status)
        || outcome.writeId !== undefined && !isId(outcome.writeId)
        || outcome.action !== undefined && !['apply', 'restore', 'cleanup'].includes(outcome.action)
        || outcome.localWriterClosed !== undefined && typeof outcome.localWriterClosed !== 'boolean'
        || kind === 'settings' && outcome.localWriterClosed === true) stop('资源结果记录无效。');
  }
  if (resource.pendingWrite !== null) {
    const pending = resource.pendingWrite;
    objectFields(pending, ['operationId', 'writeId', 'action', 'confirmedPreviewRevision', 'targetRevisionAtPlan', 'beforeState', 'expectedBefore', 'expectedAfter', 'stageRef', 'protocol', 'result', 'permit', 'actual']);
    if (!isId(pending.operationId) || !isId(pending.writeId) || !['apply', 'restore', 'cleanup'].includes(pending.action)
        || !integer(pending.confirmedPreviewRevision) || !integer(pending.targetRevisionAtPlan)) stop('资源写入意图无效。');
    for (const snapshot of [pending.expectedBefore, pending.expectedAfter]) validSnapshot(snapshot);
    if (!['untouched', 'applied', 'reused', 'reverted'].includes(pending.beforeState)
        || !['pending', 'settled'].includes(pending.result) || !['unknown', 'closed'].includes(pending.permit)) stop('写入结果/许可无效。');
    if (pending.result === 'settled') { validSnapshot(pending.actual); if (pending.permit !== 'closed') stop('已核对结果缺少关闭许可。'); }
    const stage = pending.stageRef;
    objectFields(stage, kind === 'settings' ? ['directory', 'commitDirectory', 'requestHash', 'localDirectory', 'localIdentity'] : ['directory', 'localIdentity']);
    if (stage.localIdentity !== undefined) {
      objectFields(stage.localIdentity, ['ino', 'dev']);
      if ([stage.localIdentity.ino, stage.localIdentity.dev].some((part) => typeof part !== 'string' || !/^[0-9]{1,30}$/.test(part))) stop('本机暂存身份无效。');
    }
    if (kind === 'settings') {
      if (!linuxPath(stage.directory)) stop('远端暂存定位无效。');
      const lines = pending.protocol?.request?.split('\n');
      const normalized = planRemoteWrite({ operationId: pending.operationId, writeId: pending.writeId, action: pending.action,
        stageParent: path.posix.dirname(stage.directory), targetPath: resource.path, expectedBefore: pending.expectedBefore,
        expectedAfter: pending.expectedAfter, mode: lines?.[7] });
      if (!same(normalized, pending.protocol) || !same(normalized.stageRef, { directory: stage.directory, commitDirectory: stage.commitDirectory, requestHash: stage.requestHash })
          || stage.localDirectory !== path.join(directory, `.upload-${pending.writeId}`)
          || target.preparation?.base?.home && path.posix.dirname(stage.directory) !== target.preparation.base.home) stop('远端协议或暂存与原意图不一致。');
    } else if (pending.protocol !== null || stage.directory !== path.join(path.dirname(resource.path), `.codex-write-${pending.writeId}`)) {
      stop('本机暂存与原意图不一致。');
    }
  }
}
function validEntry(value) {
  objectFields(value, ['version', 'entryRevision', 'currentTargetId', 'lastTransitionId']);
  if (!value || value.version !== 3 || !integer(value.entryRevision)
      || !(value.currentTargetId === null || isId(value.currentTargetId))
      || !(value.lastTransitionId === null || isId(value.lastTransitionId))) stop('入口 schema 无效；停止写入。');
  return value;
}
function validTarget(value, id, directory) {
  objectFields(value, ['version', 'targetId', 'targetRevision', 'lifecycle', 'connection', 'connectionResource', 'currentCycleId', 'proxyCycles', 'preparation', 'lastChecks', 'pendingTransition', 'migration', 'abandonment']);
  if (!value || value.version !== 3 || value.targetId !== id || !isId(id)
      || !integer(value.targetRevision) || !['active', 'abandoning', 'archived'].includes(value.lifecycle)
      || !Array.isArray(value.proxyCycles) || !value.connection || !value.connectionResource
      || !Object.hasOwn(value, 'pendingTransition')) stop('目标 schema 无效；停止写入。');
  const connection = value.connection;
  objectFields(connection, ['alias', 'hostname', 'username', 'sshPort', 'sshConfig', 'identity']);
  if (typeof connection.alias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(connection.alias)
      || typeof connection.sshConfig !== 'string' || !path.isAbsolute(connection.sshConfig)) stop('目标连接记录无效。');
  if (configPath(connection.sshConfig) !== connection.sshConfig) stop('目标配置路径不规范。');
  if (value.migration) {
    objectFields(value.migration, ['sourceVersion', 'sourceHash', 'phase', 'remoteStaging', 'remoteMode', 'listenerTool', 'needsResourceReconciliation']);
    const migration = value.migration;
    if (![1, 2].includes(migration.sourceVersion) || !/^[a-f0-9]{64}$/.test(migration.sourceHash)
        || !['prepared', 'local-written', 'remote-written', 'applied'].includes(migration.phase)
        || !(migration.remoteStaging === null || linuxPath(migration.remoteStaging)) || !/^[0-7]{3,4}$/.test(migration.remoteMode)
        || !['ss', 'netstat', 'proc'].includes(migration.listenerTool) || migration.needsResourceReconciliation !== true) stop('迁移来源记录无效。');
    if (connection.identity !== 'unknown' || [connection.hostname, connection.username, connection.sshPort].some((item) => item !== null)) stop('迁移连接身份无效。');
  } else {
    const normalized = normalizeConnection({ inputMode: 'direct', hostname: connection.hostname, username: connection.username, sshPort: connection.sshPort });
    if (normalized.hostname !== connection.hostname || connection.identity !== undefined) stop('目标连接身份无效。');
  }
  objectFields(value.preparation, ['base', 'local', 'declaration', 'connectionMode', 'server', 'settingsMode', 'codex']);
  const ids = new Set();
  for (const cycle of value.proxyCycles) {
    objectFields(cycle, ['cycleId', 'status', 'parameters', 'forwarding', 'settings', 'startedAt', 'endedAt', 'outcome', 'confirmedPreviewRevision']);
    if (!cycle || !isId(cycle.cycleId) || ids.has(cycle.cycleId) || !['preparing', 'configured', 'removed'].includes(cycle.status)) stop('配置周期无效。');
    ids.add(cycle.cycleId);
    objectFields(cycle.parameters, ['localProxy', 'remotePort']);
    if (normalizeProxy(cycle.parameters.localProxy).localProxy !== cycle.parameters.localProxy || port(cycle.parameters.remotePort) !== cycle.parameters.remotePort) stop('配置周期参数无效。');
    validResource(cycle.forwarding, 'forwarding', value, directory); validResource(cycle.settings, 'settings', value, directory);
  }
  validResource(value.connectionResource, 'connection', value, directory);
  if (!(value.currentCycleId === null || isId(value.currentCycleId))
      || value.currentCycleId && !value.proxyCycles.some((cycle) => cycle.cycleId === value.currentCycleId)) stop('配置周期无效。');
  return value;
}

// 调用方必须已持原 operation.lock；这些写入只处理工具自身元数据。
async function replaceRecordFile(file, value, expectedHash) {
  const before = await readRecord(file);
  if ((before?.hash ?? null) !== expectedHash) stop('状态来源变化，停止写入。');
  const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (content.length > MAX_RECORD) stop('状态记录过大。');
  const temporary = path.join(path.dirname(file), `.state-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content); await handle.sync(); await handle.close();
    const check = await readRecord(file);
    if ((check?.hash ?? null) !== expectedHash) stop('替换前状态来源变化，停止写入。');
    if (before) await fs.rename(temporary, file);
    else await fs.link(temporary, file); // 不存在条件下发布完整文件，不覆盖后来出现的文件。
    const saved = await readRecord(file);
    if (saved.hash !== sha256(content)) stop('状态保存后复读不一致。');
    return saved;
  } finally { await handle.close().catch(() => {}); await fs.rm(temporary, { force: true }); }
}

export function newResource(resourcePath = null) {
  return { state: 'untouched', path: resourcePath, firstRecovery: null, pendingWrite: null, lastOutcome: null };
}

export function createStateStore(directory, instance, { afterSave = async () => {} } = {}) {
  if (!instance || instance.directory !== path.resolve(directory)) stop('状态目录与工作实例不匹配。');
  const activePath = path.join(directory, 'active.json');
  const targetsPath = path.join(directory, 'targets');
  const preferencesPath = path.join(directory, 'preferences.json');
  const replaceRecord = async (...args) => {
    const saved = await replaceRecordFile(...args);
    await afterSave({ file: args[0], hash: saved.hash });
    return saved;
  };
  const targetPath = (id) => { if (!isId(id)) stop('目标标识无效。'); return path.join(targetsPath, `${id}.json`); };
  const readEntry = async () => {
    const record = await readRecord(activePath);
    if (record) validEntry(record.value);
    return record;
  };
  const readTarget = async (id) => {
    const record = await readRecord(targetPath(id));
    if (record) validTarget(record.value, id, directory);
    return record;
  };
  const write = (action) => instance.withWriteLock(action);
  const checkedUpdate = (old, changed) => {
    const next = { ...changed, version: 3, targetId: old.targetId, targetRevision: old.targetRevision + 1 };
    validTarget(next, old.targetId, directory);
    if (next.lifecycle !== old.lifecycle || !same(next.pendingTransition, old.pendingTransition)) stop('普通更新不能切换生命周期或入口。');
    if (!same(next.connection, old.connection) || next.currentCycleId !== old.currentCycleId
        || next.proxyCycles.length !== old.proxyCycles.length) stop('普通更新不能改变连接身份或配置周期。');
    if (!same(next.migration, old.migration)) stop('普通更新不能改写迁移来源证据。');
    const priorResources = [old.connectionResource], nextResources = [next.connectionResource];
    for (let index = 0; index < old.proxyCycles.length; index++) {
      const prior = old.proxyCycles[index], later = next.proxyCycles[index];
      if (later.cycleId !== prior.cycleId || !same(later.parameters, prior.parameters)
          || prior.status === 'removed' && !same(prior, later)) stop('不能改写已有周期身份、参数或已结束结果。');
      priorResources.push(prior.forwarding, prior.settings); nextResources.push(later.forwarding, later.settings);
    }
    for (let index = 0; index < priorResources.length; index++) {
      if (priorResources[index].firstRecovery !== null && !same(priorResources[index].firstRecovery, nextResources[index]?.firstRecovery)) stop('首次恢复依据不可覆盖。');
    }
    return next;
  };
  const readPreferences = async () => {
    const record = await readRecord(preferencesPath);
    if (record) {
      const { version, revision, ...values } = record.value;
      const normalized = preferencesValues(values);
      if (version !== 1 || !integer(revision) || Object.keys(normalized).some((key) => values[key] !== normalized[key])) stop('偏好 schema 无效；停止写入。');
    }
    return record;
  };

  const inspect = async () => {
    const entry = await readRecord(activePath);
    const legacy = !!entry && [1, 2].includes(entry.value?.version);
    if (entry && !legacy) validEntry(entry.value);
    let names;
    try { await assertPlainDirectory(targetsPath); names = await fs.readdir(targetsPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
    const targets = [];
    for (const name of names) {
      if (!name.endsWith('.json') || !isId(name.slice(0, -5))) stop('目标目录包含未知记录；需只读核对。');
      targets.push(await readTarget(name.slice(0, -5)));
    }
    const pending = targets.filter((record) => record.value.pendingTransition?.status === 'pending');
    const current = entry?.value.currentTargetId ? targets.find((record) => record.value.targetId === entry.value.currentTargetId) : null;
    if (entry?.value.currentTargetId && !current) stop('入口指向缺失目标；保留记录。');
    if (targets.some((record) => record !== current && record.value.lifecycle !== 'archived'
        && record.value.pendingTransition?.status !== 'pending')) stop('发现无法解释的孤立目标；禁止自动选择入口。');
    if (current?.value.lifecycle === 'archived' && current.value.pendingTransition?.status !== 'pending') stop('入口指向已归档目标；停止写入。');
    return { entry, targets, pending, current, legacy };
  };

  const completeTransition = async (target, entry) => {
    const intent = target.value.pendingTransition;
    if (!intent || intent.status !== 'pending' || intent.confirmed !== true || !isId(intent.transitionId)) stop('切换意图不完整。');
    const currentId = entry?.value.currentTargetId ?? null;
    const nextId = intent.toTargetId;
    if (!(nextId === null || nextId === target.value.targetId)) stop('切换目标不一致。');
    if (intent.kind === 'create' && (intent.fromTargetId !== null || nextId !== target.value.targetId || target.value.lifecycle !== 'active')) stop('新建切换意图不一致。');
    if (intent.kind === 'migration' && (intent.fromTargetId !== null || nextId !== target.value.targetId || target.value.lifecycle !== 'active'
        || target.value.migration?.sourceHash !== intent.expectedEntryHash || intent.expectedEntryRevision !== null)) stop('迁移切换来源不一致。');
    if (intent.kind === 'archive' && (intent.fromTargetId !== target.value.targetId || nextId !== null || target.value.lifecycle !== 'archived')) stop('归档切换意图不一致。');
    if (!['create', 'archive', 'migration'].includes(intent.kind)) stop('切换种类尚不受支持。');
    const alreadySwitched = entry?.value.lastTransitionId === intent.transitionId && currentId === nextId;
    if (alreadySwitched && entry.value.entryRevision !== (intent.expectedEntryRevision ?? 0) + 1) stop('切换 revision 不一致；保留记录。');
    if (!alreadySwitched) {
      if ((entry?.hash ?? null) !== intent.expectedEntryHash || (entry?.value.entryRevision ?? null) !== intent.expectedEntryRevision
          || currentId !== intent.fromTargetId) stop('切换来源不一致；不猜测入口。');
      const next = { version: 3, entryRevision: (entry?.value.entryRevision ?? 0) + 1, currentTargetId: nextId, lastTransitionId: intent.transitionId };
      entry = await replaceRecord(activePath, next, entry?.hash ?? null);
    }
    const completed = { ...target.value, targetRevision: target.value.targetRevision + 1,
      pendingTransition: { ...intent, status: 'completed' } };
    await replaceRecord(targetPath(completed.targetId), completed, target.hash);
    return entry.value;
  };

  return {
    readEntry, readTarget, readPreferences, inspect,
    async savePreferences({ expectedRevision, values }) {
      const normalized = preferencesValues(values);
      return write(async () => {
        const before = await readPreferences();
        if ((before?.value.revision ?? null) !== expectedRevision) stop('偏好 revision 已变化。');
        const next = { version: 1, revision: (before?.value.revision ?? -1) + 1, ...normalized };
        await replaceRecord(preferencesPath, next, before?.hash ?? null); return next;
      });
    },
    async initializeEntry() {
      return write(async () => {
        const current = await readEntry();
        if (current) return current.value;
        // 有孤立记录时必须先核对，不能建立空入口掩盖未完成切换。
        const observed = await inspect();
        if (observed.targets.length) stop('发现孤立目标；先核对，未建立空入口。');
        const value = { version: 3, entryRevision: 0, currentTargetId: null, lastTransitionId: null };
        await replaceRecord(activePath, value, null); return value;
      });
    },
    async createTarget({ expectedEntryRevision, confirmedPreviewRevision, connection }) {
      if (!integer(confirmedPreviewRevision)) stop('缺少已确认预览。');
      return write(async () => {
        const observed = await inspect(); const entry = observed.entry;
        if (!entry || entry.value.entryRevision !== expectedEntryRevision || entry.value.currentTargetId !== null || observed.pending.length) stop('入口已变化或存在未完成切换。');
        await ensureDirectory(targetsPath);
        const id = randomUUID();
        const value = { version: 3, targetId: id, targetRevision: 0, lifecycle: 'active', connection,
          connectionResource: newResource(connection.sshConfig), currentCycleId: null, proxyCycles: [], preparation: {}, lastChecks: null,
          pendingTransition: { status: 'pending', kind: 'create', transitionId: randomUUID(), confirmed: true, confirmedPreviewRevision,
            expectedEntryHash: entry.hash, expectedEntryRevision, fromTargetId: null, toTargetId: id } };
        validTarget(value, id, directory);
        const target = await replaceRecord(targetPath(id), value, null);
        await completeTransition(target, entry);
        return (await readTarget(id)).value;
      });
    },
    async reconcile() {
      return write(async () => {
        const observed = await inspect();
        if (observed.pending.length > 1) stop('存在多个待切换候选；保留所有记录，禁止自动激活。');
        if (!observed.pending.length) {
          if (observed.legacy) stop('旧记录需要明确确认迁移；未修改原件。');
          return observed.entry?.value ?? null;
        }
        return completeTransition(observed.pending[0], observed.entry);
      });
    },
    async migrateLegacy({ expectedSourceHash, confirmedPreviewRevision }) {
      if (!integer(confirmedPreviewRevision) || !/^[a-f0-9]{64}$/.test(expectedSourceHash ?? '')) stop('缺少已确认迁移预览。');
      return write(async () => {
        const observed = await inspect();
        if (!observed.legacy) {
          if (observed.current?.value.migration?.sourceHash === expectedSourceHash) return observed.current.value;
          stop('迁移来源已变化。');
        }
        if (observed.entry.hash !== expectedSourceHash) stop('迁移来源已变化。');
        const contents = legacyContents(observed.entry.value);
        if (observed.pending.length > 1) stop('存在多个迁移候选；停止选择。');
        if (observed.pending.length) {
          const pending = observed.pending[0];
          if (pending.value.pendingTransition.kind !== 'migration' || pending.value.migration?.sourceHash !== expectedSourceHash) stop('迁移候选来源不一致。');
          await completeTransition(pending, observed.entry); return (await readTarget(pending.value.targetId)).value;
        }
        await ensureDirectory(targetsPath);
        const id = randomUUID(), cycleId = randomUUID();
        const value = { version: 3, targetId: id, targetRevision: 0, lifecycle: 'active', connection: contents.connection,
          connectionResource: { ...newResource(contents.connection.sshConfig), state: 'reused', firstRecovery: { owned: false, reason: 'legacy-existing-alias' } },
          currentCycleId: cycleId, proxyCycles: [{ cycleId, status: 'preparing', parameters: contents.parameters,
            forwarding: { ...newResource(contents.connection.sshConfig), state: 'unknown', firstRecovery: contents.recovery.ssh },
            settings: { ...newResource(contents.remoteSettings), state: 'unknown', firstRecovery: contents.recovery.settings },
            startedAt: null, endedAt: null, outcome: null }], preparation: {}, lastChecks: null,
          migration: { sourceVersion: observed.entry.value.version, sourceHash: expectedSourceHash, phase: contents.phase,
            remoteStaging: contents.remoteStaging, remoteMode: contents.remoteMode, listenerTool: contents.listenerTool, needsResourceReconciliation: true },
          pendingTransition: { status: 'pending', kind: 'migration', transitionId: randomUUID(), confirmed: true, confirmedPreviewRevision,
            expectedEntryHash: expectedSourceHash, expectedEntryRevision: null, fromTargetId: null, toTargetId: id } };
        validTarget(value, id, directory);
        const saved = await replaceRecord(targetPath(id), value, null);
        await completeTransition(saved, observed.entry); return (await readTarget(id)).value;
      });
    },
    async updateTarget(id, expectedRevision, change) {
      return this.withTargetWrite(id, expectedRevision, async ({ save }) => save(change));
    },
    // 一次配置写入的意图、真实提交与结果共持原写入锁，内部保存不再嵌套取锁。
    async withTargetWrite(id, expectedRevision, action) {
      return write(async (lease) => {
        const entry = await readEntry(); const old = await readTarget(id);
        if (!old || entry?.value.currentTargetId !== id || old.value.targetRevision !== expectedRevision
            || old.value.lifecycle === 'archived' || old.value.pendingTransition?.status === 'pending') stop('目标状态或 revision 已变化。');
        let current = old;
        let open = true;
        const context = {
          lease,
          get target() { return structuredClone(current.value); },
          async save(change) {
            if (!open) stop('写入上下文已结束。');
            await lease.assertOwned();
            const freshEntry = await readEntry(); const fresh = await readTarget(id);
            if (freshEntry?.value.currentTargetId !== id || fresh?.hash !== current.hash) stop('配置写入期间目标已变化。');
            const next = checkedUpdate(current.value, await change(structuredClone(current.value)));
            current = await replaceRecord(targetPath(id), next, current.hash);
            return structuredClone(current.value);
          },
        };
        try { return await action(context); } finally { open = false; }
      });
    },
    async beginProxyCycle(id, expectedRevision, confirmedPreviewRevision, parameters) {
      if (!integer(confirmedPreviewRevision)) stop('缺少新周期确认。');
      const normalized = preferencesValues(parameters);
      if (Object.keys(normalized).some((key) => !['localProxy', 'remotePort'].includes(key))) stop('周期只能包含代理参数。');
      return write(async () => {
        const observed = await inspect(); const target = observed.current;
        if (observed.pending.length || !target || target.value.targetId !== id || target.value.targetRevision !== expectedRevision
            || target.value.lifecycle !== 'active' || target.value.proxyCycles.some((cycle) => cycle.status !== 'removed')) stop('目标变化或上个配置周期尚未移除。');
        const cycleId = randomUUID();
        const cycle = { cycleId, status: 'preparing', confirmedPreviewRevision, parameters: normalized,
          forwarding: newResource(target.value.connection.sshConfig), settings: newResource(), startedAt: new Date().toISOString(), endedAt: null, outcome: null };
        const next = { ...target.value, targetRevision: expectedRevision + 1, currentCycleId: cycleId, proxyCycles: [...target.value.proxyCycles, cycle] };
        validTarget(next, id, directory);
        await replaceRecord(targetPath(id), next, target.hash); return next;
      });
    },
    async archiveTarget(id, expectedRevision, confirmedPreviewRevision) {
      if (!integer(confirmedPreviewRevision)) stop('缺少弃用确认。');
      return write(async () => {
        const observed = await inspect(); const entry = observed.entry; const target = observed.current;
        if (observed.pending.length || !target || target.value.targetId !== id || target.value.targetRevision !== expectedRevision
            || target.value.lifecycle !== 'abandoning' || !['retained', 'completed'].includes(target.value.abandonment?.localCleanup)) stop('仅可归档已明确弃用且本机清理已结束或确认保留的当前目标。');
        const value = { ...target.value, lifecycle: 'archived', targetRevision: expectedRevision + 1,
          pendingTransition: { status: 'pending', kind: 'archive', transitionId: randomUUID(), confirmed: true, confirmedPreviewRevision,
            expectedEntryHash: entry.hash, expectedEntryRevision: entry.value.entryRevision, fromTargetId: id, toTargetId: null } };
        const saved = await replaceRecord(targetPath(id), value, target.hash);
        return completeTransition(saved, entry);
      });
    },
    async beginAbandonment(id, expectedRevision, confirmedPreviewRevision, retainLocalConflicts = false) {
      if (!integer(confirmedPreviewRevision) || typeof retainLocalConflicts !== 'boolean') stop('缺少弃用确认。');
      return write(async () => {
        const entry = await readEntry(); const target = await readTarget(id);
        if (!target || entry?.value.currentTargetId !== id || target.value.targetRevision !== expectedRevision
            || target.value.lifecycle !== 'active' || target.value.pendingTransition?.status === 'pending') stop('目标状态或 revision 已变化。');
        const localResources = [target.value.connectionResource, ...target.value.proxyCycles.map((cycle) => cycle.forwarding)];
        const unresolved = localResources.filter((resource) => resource?.pendingWrite || ['unknown', 'intended'].includes(resource?.state));
        const closed = (resource) => resource.lastOutcome?.localWriterClosed === true && (resource.pendingWrite
          ? resource.lastOutcome.writeId === resource.pendingWrite.writeId : !!target.value.migration && resource.lastOutcome.status === 'conflict');
        if (unresolved.length && (!retainLocalConflicts || unresolved.some((resource) => !closed(resource)))) stop('本机写入尚未确认；不能开始弃用。');
        const next = { ...target.value, targetRevision: expectedRevision + 1, lifecycle: 'abandoning',
          abandonment: { confirmedPreviewRevision, localCleanup: retainLocalConflicts ? 'retained' : 'pending' } };
        await replaceRecord(targetPath(id), next, target.hash); return next;
      });
    },
  };
}
