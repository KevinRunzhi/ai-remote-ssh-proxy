import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { normalizeConnection, normalizeProxy, port, configPath } from './input.mjs';
import { planConnection, planForwarding, planSettings, planResourceRestore, contentSnapshot, ConfigError } from './config.mjs';
import { readLocalConfig } from './local-config.mjs';
import { createResourceOperations } from './resources.mjs';
import { preflightRemoteBase } from './preflight.mjs';
import { detectLocalTools, locateRemoteServer, serverPreparationInstructions, officialGuides } from './vscode.mjs';
import { ExpectedError, CancelledError, sshEffective, effectiveConnection, assertEffectiveForwardChange,
  hasExpectedRemoteForward, probeLocalProxy, remoteListeners, classifyEndpoint, remoteRead, preflightRemote, verifyTarget } from './ssh.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const operationKinds = Object.freeze(['initialize', 'resume', 'verify', 'remove', 'abandon']);
// 候选版本仍需 S06/S10 的官方首次安装和真实进程证据，不能据此称已支持。
export const candidateCodexVersion = '26.1021.22027';
function fail(message) { throw new ExpectedError(message); }
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail('操作包含不支持的字段。');
}
export function normalizeOperationInput(input) {
  fields(input, ['kind', 'declaration', 'connection', 'localProxy', 'remotePort', 'sshConfig', 'codePath', 'targetId', 'expectedTargetRevision', 'reconfigure', 'pid', 'stateRecovery']);
  if (!operationKinds.includes(input.kind)) fail('操作种类无效。');
  const result = { kind: input.kind };
  if (input.stateRecovery !== undefined) {
    if (input.kind !== 'resume' || Object.keys(input).some((key) => !['kind', 'stateRecovery'].includes(key))) fail('元数据核对不能同时启动目标操作。');
    fields(input.stateRecovery, ['expectedEntryHash']);
    const hash = input.stateRecovery.expectedEntryHash;
    if (!(hash === null || typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) fail('元数据核对来源无效。');
    return { kind: 'resume', stateRecovery: { expectedEntryHash: hash } };
  }
  if (input.kind === 'initialize') {
    if (input.declaration !== 'new-or-rebuilt') fail('请明确声明这是新建或重建的容器。');
    if (['targetId', 'expectedTargetRevision', 'reconfigure', 'pid'].some((key) => input[key] !== undefined)) fail('新目标不能继承旧身份或周期。');
    if (input.sshConfig !== undefined && input.connection?.sshConfig !== undefined && configPath(input.sshConfig) !== configPath(input.connection.sshConfig)) fail('两处 SSH config 入口矛盾。');
    return { ...result, declaration: input.declaration, connection: normalizeConnection(input.connection),
      localProxy: normalizeProxy(input.localProxy).localProxy, remotePort: port(input.remotePort ?? 17890),
      sshConfig: configPath(input.sshConfig ?? input.connection.sshConfig ?? path.join(os.homedir(), '.ssh', 'config')),
      ...(input.codePath !== undefined ? { codePath: configPath(input.codePath) } : {}) };
  }
  if (['connection', 'localProxy', 'remotePort', 'sshConfig', 'codePath'].some((key) => input[key] !== undefined)) fail('已有目标只能使用记录中的连接和代理参数。');
  if (typeof input.targetId !== 'string' || !UUID.test(input.targetId) || !Number.isSafeInteger(input.expectedTargetRevision) || input.expectedTargetRevision < 0) fail('缺少当前目标及 revision。');
  if (input.kind !== 'abandon' && input.declaration !== 'original-container') fail('请声明这是记录中的原容器；重建后应先弃用旧目标。');
  if (input.reconfigure !== undefined && (input.kind !== 'resume' || typeof input.reconfigure !== 'boolean')) fail('仅继续操作可以明确重新配置。');
  if (input.pid !== undefined && (input.kind !== 'verify' || !Number.isSafeInteger(input.pid) || input.pid < 1)) fail('进程选择无效。');
  return { ...result, targetId: input.targetId, expectedTargetRevision: input.expectedTargetRevision,
    ...(input.kind !== 'abandon' ? { declaration: input.declaration } : {}),
    ...(input.reconfigure !== undefined ? { reconfigure: input.reconfigure } : {}), ...(input.pid !== undefined ? { pid: input.pid } : {}) };
}

function resource(target, kind) {
  if (kind === 'connection') return target.connectionResource;
  return target.proxyCycles.find((item) => item.cycleId === target.currentCycleId)?.[kind] ?? null;
}
function cycle(target) { return target.proxyCycles.find((item) => item.cycleId === target.currentCycleId) ?? null; }
function sameSnapshot(a, b) { return a?.exists === b?.exists && a?.sha256 === b?.sha256; }

export async function runOperation(rawInput, io, dependencies) {
  const input = normalizeOperationInput(rawInput);
  const { store, directory, signal, recoverySignal } = dependencies;
  if (!store || !directory || typeof io?.confirm !== 'function' || typeof io?.waitForUser !== 'function') fail('工作流缺少状态/交互依赖。');
  const ops = { readLocalConfig, sshEffective, effectiveConnection, assertEffectiveForwardChange, hasExpectedRemoteForward,
    probeLocalProxy, remoteListeners, classifyEndpoint, remoteRead, preflightRemoteBase, preflightRemote, verifyTarget,
    detectLocalTools, locateRemoteServer, ...dependencies };
  const resources = dependencies.resources ?? createResourceOperations({ store, directory, dependencies: ops });
  const operationId = dependencies.operationId ?? randomUUID();
  const now = dependencies.now ?? Date.now;
  let target = null, stage = 'state', previewRevision = 0, checks = [], forwardingChanged = false;
  const notify = (event) => io.notify?.({ operationId, ...event });
  const active = () => { if (signal?.aborted) throw new CancelledError('已取消本次操作。'); };
  const fresh = async () => {
    active();
    const observed = await store.inspect();
    if (observed.pending.length || observed.legacy) fail('入口有待核对切换或旧记录；不能继续配置。');
    if (target && (observed.current?.value.targetId !== target.targetId || observed.current.value.targetRevision !== target.targetRevision)) fail('目标或 revision 已变化；旧确认失效。');
    return observed;
  };
  const transport = () => ({ host: target.connection.alias, sshConfig: target.connection.sshConfig, signal, notify });
  const setStage = (value) => { stage = value; notify({ stage, status: 'running' }); };
  const ask = async (question, type = 'confirm') => {
    await fresh(); const issued = now(); const revision = ++previewRevision;
    notify({ stage, status: 'waiting-user' });
    const answer = await io[type]({ ...question, operationId, previewRevision: revision, targetId: target?.targetId ?? null,
      targetRevision: target?.targetRevision ?? null, expiresAt: type === 'confirm' ? issued + 600_000 : null });
    await fresh();
    if (type === 'confirm' && now() - issued > 600_000) fail('预览已过期，请重新发起操作。');
    if (!question.choices.includes(answer)) fail('回答不属于当前问题的允许选项。');
    notify({ stage, status: 'running' }); return { choice: answer, revision };
  };
  const confirm = async (question) => {
    const answer = await ask({ ...question, choices: ['confirm', 'cancel'] });
    if (answer.choice !== 'confirm') throw new CancelledError('未确认本次变更。'); return answer.revision;
  };
  const save = async (change) => { await fresh(); target = await store.updateTarget(target.targetId, target.targetRevision, change); };
  const result = (outcome, nextAction = null, extra = {}) => ({ operationId, kind: input.kind, outcome, stage, checks, nextAction,
    target: target ? { targetId: target.targetId, targetRevision: target.targetRevision, alias: target.connection.alias,
      hostname: target.connection.hostname, username: target.connection.username, lifecycle: target.lifecycle, cycleStatus: cycle(target)?.status ?? null } : null,
    userUsability: 'unconfirmed', proxyAttribution: 'unconfirmed', ...extra });
  const apply = async (kind, plan, action = 'apply', extra = {}) => {
    const revision = await confirm({ title: action === 'restore' ? '确认恢复工具拥有的增量' : '确认配置变更',
      resource: kind, path: plan.path, changes: plan.preview, before: plan.expectedBefore, after: plan.expectedAfter,
      impact: kind === 'connection' ? '建立 SSH 连接块；本次有效配置核对失败时仅撤销该增量' : kind === 'forwarding' ? '仅本机转发；核对失败仅撤销该增量；正常移除保留连接' : '仅远端两个代理字段' });
    await fresh();
    const committed = await resources.commit({ targetId: target.targetId, expectedTargetRevision: target.targetRevision, kind,
      cycleId: kind === 'connection' ? null : target.currentCycleId, plan, action, operationId, confirmedPreviewRevision: revision,
      stageParent: target.preparation.base?.home, signal, recoverySignal, notify, ...extra });
    target = committed.target;
    if (committed.outcome !== 'succeeded') return result(committed.outcome === 'not-applied' ? 'failed' : 'recovery-required', 'reconcile-resource');
    if (signal?.aborted) return result('cancelled', 'resume');
    return null;
  };
  const reconcile = async (localOnly = false) => {
    let localConflict = false;
    for (const kind of localOnly ? ['connection', 'forwarding'] : ['connection', 'forwarding', 'settings']) {
      const item = resource(target, kind); if (!item || cycle(target)?.status === 'removed' && kind !== 'connection') continue;
      if (!item.pendingWrite && !['intended', 'unknown'].includes(item.state)) continue;
      await fresh();
      const reconciled = await resources.reconcile({ targetId: target.targetId, expectedTargetRevision: target.targetRevision, kind,
        cycleId: kind === 'connection' ? null : target.currentCycleId, signal, notify }); target = reconciled.target;
      if (reconciled.outcome === 'recovery-required') {
        if (!localOnly || !reconciled.localWriterClosed) return result('recovery-required', 'reconcile-resource');
        localConflict = true;
      }
    }
    return localConflict ? result('recovery-required', 'reconcile-resource', { localWriterClosed: true }) : null;
  };
  const assertIdentity = async (base) => {
    const prior = target.preparation.base;
    if (prior && ['home', 'uid', 'architecture'].some((key) => prior[key] !== base[key])) fail('当前用户/home/架构与原容器记录不一致；请核对是否重建。');
    const effective = ops.effectiveConnection(await ops.sshEffective(transport()));
    if (['hostname', 'username', 'sshPort'].some((key) => effective[key] !== target.connection[key])) fail('有效 SSH 连接与原记录不一致；停止旧目标操作。');
  };
  const restore = async (kind) => {
    const item = resource(target, kind);
    if (!item || ['untouched', 'reverted', 'reused'].includes(item.state) || !item.firstRecovery?.owned) return null;
    await fresh();
    const text = kind === 'settings' ? (await ops.remoteRead(transport(), item.path)).text : (await ops.readLocalConfig(item.path)).text;
    const plan = planResourceRestore({ kind, text, filePath: item.path, firstRecovery: item.firstRecovery });
    return apply(kind, plan, 'restore', kind === 'settings' ? { mode: target.preparation.settingsMode ?? '600' } : {});
  };
  const rollbackLocal = async (kind) => {
    const item = resource(target, kind);
    if (!item?.firstRecovery?.owned || item.pendingWrite || item.state !== 'applied') return result('failed', 'review-effective-ssh');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300_000); timer.unref();
    const abort = () => controller.abort(); recoverySignal?.addEventListener('abort', abort, { once: true });
    if (recoverySignal?.aborted) controller.abort();
    try {
      const text = (await ops.readLocalConfig(item.path)).text;
      const plan = planResourceRestore({ kind, text, filePath: item.path, firstRecovery: item.firstRecovery });
      const restored = await resources.commit({ targetId: target.targetId, expectedTargetRevision: target.targetRevision, kind,
        cycleId: kind === 'connection' ? null : target.currentCycleId, plan, action: 'restore', operationId,
        confirmedPreviewRevision: previewRevision, signal: controller.signal, recoverySignal, notify });
      target = restored.target;
      return result(restored.outcome === 'succeeded' ? 'failed' : 'recovery-required', 'review-effective-ssh');
    } catch { return result('recovery-required', 'reconcile-resource'); }
    finally { clearTimeout(timer); recoverySignal?.removeEventListener('abort', abort); }
  };

  try {
    if (input.stateRecovery) {
      const observed = await store.inspect(), entryHash = observed.entry?.hash ?? null;
      if (entryHash !== input.stateRecovery.expectedEntryHash || !observed.legacy && !observed.pending.length) fail('元数据核对来源已变化。');
      const identity = (value) => JSON.stringify([value.entry?.hash ?? null, value.targets.map((item) => [item.value.targetId, item.hash]).sort()]);
      const before = identity(observed), issued = now(), revision = ++previewRevision;
      const choice = await io.confirm({ title: observed.legacy ? '迁移旧恢复记录' : '核对唯一已确认的入口切换',
        impact: '仅收敛本机元数据；保留原恢复依据，不连接远端、不重放配置。完成后再明确选择原目标操作。',
        previewRevision: revision, expiresAt: issued + 600_000, choices: ['confirm', 'cancel'] });
      active();
      if (choice !== 'confirm') return result('cancelled', 'review-records');
      if (now() - issued > 600_000 || before !== identity(await store.inspect())) fail('核对确认已过期或来源变化。');
      if (observed.legacy) target = await store.migrateLegacy({ expectedSourceHash: entryHash, confirmedPreviewRevision: revision });
      else { await store.reconcile(); target = (await store.inspect()).current?.value ?? null; }
      return result('needs-user', 'review-current-target');
    }
    const observed = await fresh();
    if (input.kind === 'initialize') {
      if (observed.current) fail('已有当前目标，请先明确弃用，不能隐式覆盖。');
      setStage('local-preflight');
      const tools = await ops.detectLocalTools({ codePath: input.codePath, sshConfig: input.sshConfig, signal });
      if (!tools.ready) return result('needs-user', { kind: 'install-local-tools', missing: tools.missing, guides: tools.guides });
      const proxy = normalizeProxy(input.localProxy);
      await ops.probeLocalProxy({ ...proxy, signal, notify });
      const sshText = (await ops.readLocalConfig(input.sshConfig)).text;
      let connection;
      if (input.connection.inputMode === 'alias') {
        const actual = ops.effectiveConnection(await ops.sshEffective({ host: input.connection.host, sshConfig: input.sshConfig, signal, notify }));
        connection = { alias: input.connection.host, ...actual, sshConfig: input.sshConfig };
      } else {
        const { hostname, username, sshPort } = input.connection;
        let alias;
        for (let attempts = 0; attempts < 10; attempts++) {
          const candidate = `codex-${randomUUID().slice(0, 8)}`;
          if (!new RegExp(`^\\s*Host\\s+.*\\b${candidate}\\b`, 'im').test(sshText ?? '')) { alias = candidate; break; }
        }
        if (!alias) fail('未取得未占用的新 alias。');
        connection = { alias, hostname, username, sshPort, sshConfig: input.sshConfig };
      }
      const declaration = await confirm({ title: '新建/重建容器', connection, localProxy: proxy.localProxy, remotePort: input.remotePort,
        impact: '生成新的本机 targetId；不继承旧容器恢复记录' });
      setStage('remote-preflight');
      const base = await ops.preflightRemoteBase({ ...input.connection, sshConfig: input.connection.inputMode === 'alias' ? input.sshConfig : undefined, signal, notify });
      if (!observed.entry) await store.initializeEntry();
      const entry = await store.readEntry();
      target = await store.createTarget({ expectedEntryRevision: entry.value.entryRevision, confirmedPreviewRevision: declaration, connection });
      target = await store.beginProxyCycle(target.targetId, target.targetRevision, declaration, { localProxy: proxy.localProxy, remotePort: input.remotePort });
      await save((value) => ({ ...value, preparation: { base, local: tools, declaration: 'new-or-rebuilt', connectionMode: input.connection.inputMode } }));
    } else {
      if (!observed.current || observed.current.value.targetId !== input.targetId || observed.current.value.targetRevision !== input.expectedTargetRevision) fail('当前目标与请求的身份/revision 不一致。');
      target = observed.current.value;
      if (target.lifecycle === 'abandoning' && input.kind !== 'abandon') fail('目标已经开始弃用，只能继续弃用。');
    }

    if (input.kind === 'abandon') {
      setStage('abandon');
      const unresolved = await reconcile(true); if (unresolved && !unresolved.localWriterClosed) return unresolved;
      if (target.lifecycle === 'active') {
        const revision = await confirm({ title: unresolved ? '弃用旧容器并保留全部本机文件' : '弃用旧容器',
          impact: unresolved ? '本机原写入已结束，当前文件有冲突；本机配置和暂存全部保留。远端不连接、不清理，历史记录归档，不用于新容器恢复。'
            : '不连接旧远端；远端配置和暂存可能未清理。归档后不能用旧记录恢复新容器。' });
        target = await store.beginAbandonment(target.targetId, target.targetRevision, revision, !!unresolved);
      }
      const answer = target.abandonment.localCleanup === 'retained'
        ? { choice: 'retain', revision: target.abandonment.confirmedPreviewRevision }
        : await ask({ title: '是否清理本机工具增量', choices: ['cleanup', 'retain'], impact: '可全部保留；原有连接和等价配置始终保留。' }, 'waitForUser');
      if (answer.choice === 'cleanup') {
        const forwardResult = await restore('forwarding'); if (forwardResult) return forwardResult;
        if (target.connectionResource.firstRecovery?.owned) {
          const selected = await ask({ title: '是否单独移除工具新建的 SSH 连接', choices: ['remove-connection', 'retain-connection'] }, 'waitForUser');
          if (selected.choice === 'remove-connection') { const connectionResult = await restore('connection'); if (connectionResult) return connectionResult; }
        }
      }
      await save((value) => ({ ...value, abandonment: { ...value.abandonment, localCleanup: answer.choice === 'retain' ? 'retained' : 'completed',
        remoteCleanup: 'unconfirmed', remoteStaging: resource(value, 'settings')?.pendingWrite?.stageRef?.directory ?? null } }));
      await store.archiveTarget(target.targetId, target.targetRevision, answer.revision);
      target = (await store.readTarget(target.targetId)).value;
      return result('succeeded', 'initialize-new-container');
    }

    if (target.migration && resource(target, 'settings')?.state === 'unknown' && !resource(target, 'settings').pendingWrite) {
      return result('recovery-required', 'legacy-remote-review-required');
    }
    setStage('reconcile');
    const unresolved = await reconcile(); if (unresolved) return unresolved;
    if (input.kind === 'remove') {
      setStage('remove');
      if (!cycle(target) || cycle(target).status === 'removed') return result('succeeded', 'ssh-connection-retained');
      if (resource(target, 'settings').firstRecovery?.owned && resource(target, 'settings').state !== 'reverted') {
        await fresh(); const base = await ops.preflightRemoteBase(transport()); await assertIdentity(base);
        const removed = await restore('settings'); if (removed) return removed;
      }
      const removed = await restore('forwarding'); if (removed) return removed;
      await save((value) => { const activeCycle = cycle(value); activeCycle.status = 'removed'; activeCycle.endedAt = new Date(now()).toISOString(); activeCycle.outcome = 'removed'; return value; });
      return result('succeeded', 'reconnect-to-release-listener');
    }

    if (input.kind === 'resume' && cycle(target)?.status === 'removed') {
      if (input.reconfigure !== true) return result('needs-user', 'explicit-reconfiguration-required');
      const revision = await confirm({ title: '重新配置代理', impact: '建立新周期和新恢复基线；保留已结束周期。', parameters: cycle(target).parameters });
      target = await store.beginProxyCycle(target.targetId, target.targetRevision, revision, cycle(target).parameters);
    }
    if (!cycle(target) || cycle(target).status === 'removed') return result('needs-user', 'configure-proxy-first');
    setStage('remote-preflight'); await fresh();
    const connectionReady = ['applied', 'reused'].includes(target.connectionResource.state);
    if (!connectionReady && input.kind === 'verify') return result('needs-user', 'finish-connection-first');
    const baseOptions = connectionReady ? transport() : { inputMode: 'direct', hostname: target.connection.hostname,
      username: target.connection.username, sshPort: target.connection.sshPort, signal, notify };
    const base = input.kind === 'initialize' ? target.preparation.base : await ops.preflightRemoteBase(baseOptions);
    const previousBase = target.preparation.base;
    if (previousBase && ['home', 'uid', 'architecture'].some((key) => previousBase[key] !== base[key])) fail('原容器的用户/home/架构不一致，停止继续。');
    if (connectionReady && input.kind !== 'initialize') await assertIdentity(base);
    const parameters = cycle(target).parameters, proxy = normalizeProxy(parameters.localProxy);
    await ops.probeLocalProxy({ ...proxy, signal, notify });

    if (input.kind !== 'verify') {
      setStage('connection');
      if (['untouched', 'reverted'].includes(target.connectionResource.state)) {
        const text = (await ops.readLocalConfig(target.connection.sshConfig)).text;
        const plan = planConnection({ sshText: text, filePath: target.connection.sshConfig, ...target.connection, targetId: target.targetId,
          reuse: target.preparation.connectionMode === 'alias' });
        const committed = await apply('connection', plan); if (committed) return committed;
      }
      try { await assertIdentity(base); } catch { return rollbackLocal('connection'); }
      setStage('forwarding');
      if (resource(target, 'settings').state === 'reverted') return result('needs-user', 'finish-remove-first');
      if (['untouched', 'reverted'].includes(resource(target, 'forwarding').state)) {
        await fresh();
        const options = transport(), before = await ops.sshEffective(options);
        const listeners = await ops.remoteListeners(options, base.listenerTool, parameters.remotePort, { strict: false });
        const endpoint = ops.classifyEndpoint({ listeners, hasExpectedForward: ops.hasExpectedRemoteForward(before, parameters.remotePort, proxy.localPort), remotePort: parameters.remotePort });
        if (endpoint.status === 'fail') fail(endpoint.message);
        const text = (await ops.readLocalConfig(target.connection.sshConfig)).text;
        const plan = planForwarding({ sshText: text, filePath: target.connection.sshConfig, alias: target.connection.alias, localPort: proxy.localPort,
          remotePort: parameters.remotePort, targetId: target.targetId, cycleId: target.currentCycleId });
        const committed = await apply('forwarding', plan); if (committed) return committed;
        forwardingChanged = plan.changed;
        try {
          const after = await ops.sshEffective(transport());
          if (plan.changed) ops.assertEffectiveForwardChange(before, after, parameters.remotePort, proxy.localPort);
          else if (!ops.hasExpectedRemoteForward(after, parameters.remotePort, proxy.localPort)) fail('有效配置没有确认复用转发。');
        } catch { return rollbackLocal('forwarding'); }
      }
    }

    setStage('server'); await fresh();
    const local = await ops.detectLocalTools({ codePath: target.preparation.local?.vscode?.codePath, sshConfig: target.connection.sshConfig, signal });
    if (!local.ready) return result('needs-user', { kind: 'install-local-tools', missing: local.missing, guides: local.guides });
    let server = await ops.locateRemoteServer(transport(), { home: base.home, commit: local.vscode.commit });
    if (server.status !== 'ready') {
      if (input.kind === 'verify') return result('needs-user', { kind: 'server', status: server.status });
      const choice = await ask(serverPreparationInstructions({ ...target.connection, remoteSshVersion: local.remoteSshVersion }), 'waitForUser');
      if (choice.choice === 'later') return result('needs-user', 'prepare-server');
      await fresh(); server = await ops.locateRemoteServer(transport(), { home: base.home, commit: local.vscode.commit });
      if (server.status !== 'ready') return result('needs-user', { kind: 'server', status: server.status });
    }
    if (resource(target, 'settings').path && resource(target, 'settings').path !== server.settingsPath) fail('实际 settings 路径与原资源不一致；未换用新路径。');
    if (dependencies.expectedRemoteSettings !== undefined && dependencies.expectedRemoteSettings !== server.settingsPath) fail('CLI 指定路径与实际 Server settings 不一致；未使用手填路径覆盖。');
    if (input.kind !== 'verify') {
      await save((value) => ({ ...value, preparation: { ...value.preparation, base, local, server } }));
      setStage('settings');
      if (resource(target, 'settings').state === 'untouched') {
        await fresh(); const current = await ops.remoteRead(transport(), server.settingsPath);
        const plan = planSettings({ settingsText: current.text, filePath: server.settingsPath, remotePort: parameters.remotePort });
        await save((value) => ({ ...value, preparation: { ...value.preparation, settingsMode: current.mode } }));
        const committed = await apply('settings', plan, 'apply', { mode: current.mode }); if (committed) return committed;
        if (plan.changed || forwardingChanged) {
          const choice = await ask({ title: '保存工作后重连目标 VS Code 窗口', steps: ['关闭本次远端窗口，用同一 alias 重连，使代理字段和转发生效。'], choices: ['ready', 'later'] }, 'waitForUser');
          if (choice.choice === 'later') return result('needs-user', 'reconnect');
        }
      }
    }

    setStage('codex'); await fresh();
    let codex;
    const inspectCodex = () => ops.preflightRemote({ ...transport(), codexHome: base.home, codexArchitecture: base.architecture });
    try { codex = await inspectCodex(); } catch (error) {
      if (error instanceof CancelledError || signal?.aborted) throw error;
      return result('needs-user', { kind: 'codex-check' });
    }
    const expected = `openai.chatgpt-${candidateCodexVersion}-${base.architecture === 'x86_64' ? 'linux-x64' : 'linux-arm64'}`;
    if (codex?.version !== expected) {
      if (input.kind === 'verify') return result('needs-user', { kind: 'codex-version', expected: candidateCodexVersion });
      const answer = await ask({ title: '在目标远端窗口的商店安装 Codex', choices: ['ready', 'later'], version: candidateCodexVersion,
        steps: [`有效注册版本：${codex?.version ?? '未安装'}；本工具内部候选版本：${candidateCodexVersion}。`,
          '在远端窗口扩展页打开 OpenAI 的 Codex，确认安装目标是 SSH 容器。', `候选 ${candidateCodexVersion} 不可取得时可稍后继续；其他已安装版本先保留，不自动升级或降级。`,
          '安装后重新打开远端窗口和 Codex，在官方界面完成登录。'], guide: officialGuides.codex,
        fallback: '商店暂不可用时可稍后继续；工具保留已完成配置，安装由你在目标远端窗口完成。' }, 'waitForUser');
      if (answer.choice === 'later') return result('needs-user', 'prepare-codex');
      await fresh(); codex = await inspectCodex();
      if (codex.version !== expected) return result('needs-user', { kind: 'codex-version', expected: candidateCodexVersion });
    }
    // 版本、路径和配置在每次运行重新核对；不复用历史“通过”。
    for (const kind of ['forwarding', 'settings']) {
      const item = resource(target, kind);
      if (!['applied', 'reused'].includes(item.state) || item.pendingWrite) fail('代理资源尚未处于可检查状态。');
      const snapshot = kind === 'settings' ? contentSnapshot((await ops.remoteRead(transport(), item.path)).text) : (await ops.readLocalConfig(item.path)).snapshot;
      if (!sameSnapshot(snapshot, { exists: true, sha256: item.firstRecovery.afterHash })) fail('配置与当前周期摘要不符；未覆盖用户修改。');
    }
    setStage('verify'); await fresh();
    const verified = await ops.verifyTarget({ ...transport(), remoteSettings: server.settingsPath, pid: input.pid,
      codexExtension: codex.version, codexRegistryHash: codex.registryHash },
      { ...parameters, localPort: proxy.localPort, listenerTool: base.listenerTool }, { preflightRemote: ops.preflightRemoteBase });
    checks = verified.checks; notify({ stage, checks });
    if (input.kind !== 'verify') await save((value) => { cycle(value).status = 'configured'; return { ...value,
      preparation: { ...value.preparation, codex: { version: codex.version, status: 'candidate-static-chain-matched' } },
      lastChecks: { checkedAt: new Date(now()).toISOString(), checks } }; });
    if (!verified.ok) return result('needs-user', 'review-checks-and-reconnect');
    const answer = await ask({ title: '自动探测已结束，请在目标 Codex 发起一次真实请求', choices: ['new-reply', 'later'],
      steps: ['请确认收到本次新回复；登录和请求只在官方界面完成。', '本次尚无进程到代理连接归因的自动证据，不能把新回复认定为路径已确认。'] }, 'waitForUser');
    return result(answer.choice === 'new-reply' ? 'succeeded' : 'needs-user', answer.choice === 'new-reply' ? 'proxy-attribution-required' : 'user-request',
      { userUsability: answer.choice === 'new-reply' ? 'user-confirmed' : 'unconfirmed', proxyAttribution: 'unconfirmed' });
  } catch (error) {
    if (error instanceof CancelledError || signal?.aborted) return result('cancelled', 'resume');
    return result('failed', 'review-and-retry', { error: error instanceof ExpectedError || error instanceof ConfigError ? error.message : '操作未能安全完成；原始错误未展示。' });
  }
}
