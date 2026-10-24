import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { contentSnapshot, restrictWindowsDirectory } from './config.mjs';
import { readLocalConfig, writeLocalPlan, cleanupLocalStage } from './local-config.mjs';
import { ExpectedError, CancelledError, runProcess, runScp, remoteRead } from './ssh.mjs';
import { planRemoteWrite, runRemoteProtocol } from './remote-protocol.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fail(message) { throw new ExpectedError(message); }
const equal = (a, b) => a?.exists === b?.exists && a?.sha256 === b?.sha256;
function resourceOf(target, kind, cycleId) {
  if (kind === 'connection') return target.connectionResource;
  if (!['forwarding', 'settings'].includes(kind) || cycleId !== target.currentCycleId) fail('资源与当前配置周期不一致。');
  const cycle = target.proxyCycles.find((item) => item.cycleId === cycleId);
  if (!cycle || cycle.status === 'removed') fail('已结束的周期不能写入。');
  return cycle[kind];
}
function transport(target, signal, notify) { return { host: target.connection.alias, sshConfig: target.connection.sshConfig, signal, notify }; }
function assertActive(signal) { if (signal?.aborted) throw new CancelledError('当前配置操作已取消。'); }
function settledState(intent, snapshot) {
  if (equal(snapshot, intent.expectedAfter)) return intent.action === 'apply' ? 'applied' : intent.action === 'restore' ? 'reverted' : intent.beforeState;
  if (equal(snapshot, intent.expectedBefore)) return intent.beforeState;
  return 'unknown';
}

// 有限的三种资源提交；adapter 只传已经确认的纯计划，不处理恢复判断。
export function createResourceOperations({ store, directory, dependencies = {} }) {
  const executeProtocol = dependencies.runRemoteProtocol ?? runRemoteProtocol;
  const readRemote = dependencies.remoteRead ?? remoteRead;
  const upload = dependencies.runScp ?? runScp;
  const writeLocal = dependencies.writeLocalPlan ?? writeLocalPlan;
  const readLocal = dependencies.readLocalConfig ?? readLocalConfig;
  const restrict = dependencies.restrictDirectory ?? (async (folder) => {
    if (process.platform === 'win32') await restrictWindowsDirectory(folder, { runProcess });
    else await fs.chmod(folder, 0o700);
  });
  const changeResource = (context, kind, cycleId, change) => context.save((target) => {
    change(resourceOf(target, kind, cycleId)); return target;
  });
  const readSnapshot = async (context, kind, resource, options) => kind === 'settings'
    ? contentSnapshot((await readRemote(options, resource.path)).text)
    : (await readLocal(resource.path)).snapshot;

  async function transfer(options, plan, intent, onStageCreated) {
    if (plan.text === null) return;
    // 本机载荷也在意图中预存定位，只有本次独占创建成功才有清理权。
    const folder = intent.stageRef.localDirectory;
    let owned = false;
    try {
      await fs.mkdir(folder, { mode: 0o700 }); owned = true;
      await restrict(folder);
      const identity = await fs.lstat(folder, { bigint: true }); await onStageCreated({ ino: identity.ino.toString(), dev: identity.dev.toString() });
      const file = path.join(folder, 'payload');
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(plan.text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await upload(options, file, `${intent.stageRef.directory}/payload`, '上传本次私有配置载荷');
    } finally {
      if (owned) { await fs.rm(path.join(folder, 'payload'), { force: true }); await fs.rmdir(folder); }
    }
  }

  async function finish(context, kind, cycleId, snapshot, options) {
    let resource = resourceOf(context.target, kind, cycleId);
    const intent = resource.pendingWrite;
    const state = settledState(intent, snapshot);
    if (state === 'unknown') {
      await changeResource(context, kind, cycleId, (item) => { item.state = 'unknown'; item.lastOutcome = { status: 'conflict', writeId: intent.writeId, localWriterClosed: kind !== 'settings' }; });
      return { outcome: 'recovery-required', target: context.target, localWriterClosed: kind !== 'settings' };
    }
    // 先保存许可已关闭和实际结果；清理失败仍保留独立定位信息。
    await changeResource(context, kind, cycleId, (item) => {
      item.state = state; item.pendingWrite = { ...intent, result: 'settled', permit: 'closed', actual: snapshot };
      item.lastOutcome = { status: equal(snapshot, intent.expectedAfter) ? 'occurred' : 'not-occurred', action: intent.action, writeId: intent.writeId, localWriterClosed: kind !== 'settings' };
    });
    resource = resourceOf(context.target, kind, cycleId);
    if (kind === 'settings') {
      const cleaned = await executeProtocol(options, 'cleanup', { ...resource.pendingWrite.protocol, closedPermit: true });
      if (cleaned.status !== 'cleaned') return { outcome: 'recovery-required', target: context.target };
    }
    const stage = resourceOf(context.target, kind, cycleId).pendingWrite.stageRef;
    const localClean = await cleanupLocalStage(kind === 'settings' ? stage.localDirectory : stage.directory, stage.localIdentity, kind === 'settings' ? 'payload' : 'content.tmp');
    if (!localClean) return { outcome: 'recovery-required', target: context.target, localWriterClosed: kind !== 'settings' };
    await changeResource(context, kind, cycleId, (item) => { item.pendingWrite = null; });
    return { outcome: equal(snapshot, intent.expectedAfter) ? 'succeeded' : 'not-applied', target: context.target };
  }

  async function reconcileLocked(context, kind, cycleId, options) {
    const resource = resourceOf(context.target, kind, cycleId), intent = resource.pendingWrite;
    if (!intent) {
      if (kind !== 'settings' && resource.state === 'unknown' && context.target.migration && resource.firstRecovery) {
        const current = await readSnapshot(context, kind, resource, options), recovery = resource.firstRecovery;
        const state = current.exists && current.sha256 === recovery.afterHash ? (recovery.owned ? 'applied' : 'reused')
          : current.exists && current.sha256 === recovery.beforeHash ? 'untouched' : 'unknown';
        await changeResource(context, kind, cycleId, (item) => {
          item.state = state;
          if (state === 'unknown') item.lastOutcome = { status: 'conflict', localWriterClosed: true };
        });
        return { outcome: state === 'unknown' ? 'recovery-required' : 'succeeded', target: context.target, localWriterClosed: true };
      }
      if (['intended', 'unknown'].includes(resource.state)) fail('缺少可核对的本次写入意图；保留资源。');
      return { outcome: 'succeeded', target: context.target };
    }
    let snapshot;
    if (kind === 'settings') {
      const receipt = intent.result === 'settled' && intent.permit === 'closed'
        ? { permit: 'closed', snapshot: await readSnapshot(context, kind, resource, options) }
        : await executeProtocol(options, 'reconcile', intent.protocol);
      if (receipt.permit !== 'closed' || !receipt.snapshot) {
        await changeResource(context, kind, cycleId, (item) => { item.state = 'unknown'; });
        return { outcome: 'recovery-required', target: context.target };
      }
      snapshot = receipt.snapshot;
    } else {
      // 原实例独占且所有本机写入同步 await，旧进程已经受实例锁恢复流程核对。
      snapshot = await readSnapshot(context, kind, resource, options);
    }
    return finish(context, kind, cycleId, snapshot, options);
  }

  return {
    async commit({ targetId, expectedTargetRevision, kind, cycleId = null, plan, action = 'apply', operationId, confirmedPreviewRevision,
      stageParent, mode = '600', signal, notify, recoverySignal }) {
      if (typeof operationId !== 'string' || !UUID.test(operationId) || !Number.isSafeInteger(confirmedPreviewRevision) || confirmedPreviewRevision < 0
          || !['apply', 'restore'].includes(action) || plan?.kind !== kind || !equal(contentSnapshot(plan.text), plan.expectedAfter)) fail('缺少精确的已确认配置计划。');
      if (action === 'apply' && (typeof plan.firstRecovery?.owned !== 'boolean' || plan.firstRecovery.owned !== plan.owned)) fail('缺少当前计划的恢复依据。');
      return store.withTargetWrite(targetId, expectedTargetRevision, async (context) => {
        assertActive(signal);
        const resource = resourceOf(context.target, kind, cycleId);
        if (resource.pendingWrite || ['intended', 'unknown'].includes(resource.state)) fail('资源有未完成写入；必须先核对，不能再次提交。');
        if (resource.path !== null && resource.path !== plan.path) fail('计划路径与资源不一致。');
        if (kind !== 'settings' && plan.path !== context.target.connection.sshConfig) fail('本机配置入口与目标不一致。');
        if (action === 'restore' && !resource.firstRecovery?.owned) fail('没有本次资源的恢复所有权。');
        if (action === 'apply' && resource.firstRecovery !== null
            && JSON.stringify(resource.firstRecovery) !== JSON.stringify(plan.firstRecovery)) fail('新计划不能覆盖首次恢复依据。');
        const options = transport(context.target, signal, notify);
        const current = kind === 'settings' ? contentSnapshot((await readRemote(options, plan.path)).text) : (await readLocal(plan.path)).snapshot;
        if (!equal(current, plan.expectedBefore)) fail('确认后配置已变化；未保存写入意图或覆盖用户内容。');
        assertActive(signal);
        if (equal(plan.expectedBefore, plan.expectedAfter)) {
          await changeResource(context, kind, cycleId, (item) => {
            item.path = plan.path;
            if (action === 'apply') { item.firstRecovery ??= plan.firstRecovery; item.state = 'reused'; }
          });
          return { outcome: 'succeeded', target: context.target };
        }
        const writeId = randomUUID();
        const protocol = kind === 'settings' ? planRemoteWrite({ operationId, writeId, action, stageParent, targetPath: plan.path,
          expectedBefore: plan.expectedBefore, expectedAfter: plan.expectedAfter, mode }) : null;
        const stageRef = kind === 'settings' ? { ...protocol.stageRef, localDirectory: path.join(directory, `.upload-${writeId}`) }
          : { directory: path.join(path.dirname(plan.path), `.codex-write-${writeId}`) };
        const intent = { operationId, writeId, action, confirmedPreviewRevision, targetRevisionAtPlan: expectedTargetRevision,
          beforeState: resource.state, expectedBefore: plan.expectedBefore, expectedAfter: plan.expectedAfter, stageRef, protocol, result: 'pending', permit: 'unknown' };
        await changeResource(context, kind, cycleId, (item) => {
          item.path = plan.path; if (action === 'apply') item.firstRecovery ??= plan.firstRecovery;
          item.pendingWrite = intent; item.state = 'intended';
        });
        try {
          assertActive(signal); await context.lease.assertOwned();
          if (kind === 'settings') {
            const allocated = await executeProtocol(options, 'allocate', protocol);
            if (allocated.status !== 'allocated') fail('远端暂存分配未确认。');
            await transfer(options, plan, intent, (identity) => changeResource(context, kind, cycleId, (item) => { item.pendingWrite.stageRef.localIdentity = identity; }));
            assertActive(signal); await context.lease.assertOwned();
            const receipt = await executeProtocol(options, 'write', protocol);
            if (receipt.permit !== 'closed' || !receipt.snapshot) fail('远端提交结果未知。');
            return await finish(context, kind, cycleId, receipt.snapshot, options);
          }
          const snapshot = await writeLocal(plan, context.lease, { stageDirectory: stageRef.directory,
            onStageCreated: (identity) => changeResource(context, kind, cycleId, (item) => { item.pendingWrite.stageRef.localIdentity = identity; }) });
          return await finish(context, kind, cycleId, snapshot, options);
        } catch {
          // 不能复用已取消 signal。收尾独立且有界；第二次取消可中止此预算。
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 300_000); timer.unref();
          const abort = () => controller.abort(); recoverySignal?.addEventListener('abort', abort, { once: true });
          if (recoverySignal?.aborted) controller.abort();
          try {
            const result = await reconcileLocked(context, kind, cycleId, transport(context.target, controller.signal, notify));
            return { ...result, interrupted: true };
          } catch {
            await changeResource(context, kind, cycleId, (item) => { item.state = 'unknown'; });
            return { outcome: 'recovery-required', interrupted: true, target: context.target };
          } finally { clearTimeout(timer); recoverySignal?.removeEventListener('abort', abort); }
        }
      });
    },
    async reconcile({ targetId, expectedTargetRevision, kind, cycleId = null, signal, notify }) {
      return store.withTargetWrite(targetId, expectedTargetRevision, (context) => reconcileLocked(context, kind, cycleId, transport(context.target, signal, notify)));
    },
  };
}
