import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { acquireWorkingInstance, acquireRecoveryGuard, inspectRecoveryProcesses } from '../scripts/instance-recovery.mjs';
import { acquireInstance, readRecord } from '../scripts/state.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-lock-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const owner = { version: 1, ownerId: randomUUID(), pid: 2147483000, processStartedAt: new Date().toISOString() };
  await fs.writeFile(path.join(directory, 'instance.lock'), JSON.stringify(owner));
  const counts = { confirmations: 0, censuses: 0, released: 0 };
  const deps = { restrictDirectory: async () => {},
    acquireRecoveryGuard: async () => ({ assertOwned() {}, async release() { counts.released++; } }),
    inspectRecoveryProcesses: async () => { counts.censuses++; return { owners: [], transports: [] }; },
    confirmRecovery: async () => { counts.confirmations++; return true; } };
  return { directory, owner, deps, counts };
}

test('受控恢复只接管锁，状态原件不变；独立回执证明无重放', async (t) => {
  const f = await fixture(t);
  const state = '{"version":3,"entryRevision":0,"currentTargetId":null,"lastTransitionId":null}';
  await fs.writeFile(path.join(f.directory, 'active.json'), state);
  await fs.writeFile(path.join(f.directory, 'operation.lock'), JSON.stringify({ ownerId: f.owner.ownerId, pid: f.owner.pid, writeId: randomUUID() }));
  const current = await acquireWorkingInstance(f.directory, f.deps);
  assert.notEqual(current.owner.ownerId, f.owner.ownerId);
  assert.equal(await fs.readFile(path.join(f.directory, 'active.json'), 'utf8'), state);
  assert.equal(await readRecord(path.join(f.directory, 'operation.lock')), null);
  const receipts = (await fs.readdir(f.directory)).filter((name) => /^recovery-.*\.json$/.test(name));
  assert.equal(receipts.length, 1);
  assert.equal((await readRecord(path.join(f.directory, receipts[0]))).value.replayedWrites, false);
  assert.equal(f.counts.confirmations, 1); assert.equal(f.counts.censuses, 2); assert.equal(f.counts.released, 1);
  await current.release();
});

test('活跃/PID复用、仍有传输、未知锁和取消均保留原件', async (t) => {
  for (const reason of ['owner', 'transport', 'schema', 'cancel']) {
    const f = await fixture(t);
    if (reason === 'owner') f.deps.inspectRecoveryProcesses = async () => ({ owners: [{ pid: f.owner.pid, startedAt: new Date().toISOString() }], transports: [] });
    if (reason === 'transport') f.deps.inspectRecoveryProcesses = async () => ({ owners: [], transports: [{ pid: 32, name: 'ssh.exe' }] });
    if (reason === 'schema') await fs.writeFile(path.join(f.directory, 'instance.lock'), '{"version":99}');
    if (reason === 'cancel') f.deps.confirmRecovery = async () => false;
    const before = await fs.readFile(path.join(f.directory, 'instance.lock'), 'utf8');
    await assert.rejects(acquireWorkingInstance(f.directory, f.deps));
    assert.equal(await fs.readFile(path.join(f.directory, 'instance.lock'), 'utf8'), before);
    assert.deepEqual(await fs.readdir(f.directory), ['instance.lock']);
  }
});

test('等待后记录变化、二次进程普查变化使确认失效', async (t) => {
  for (const mutate of ['record', 'process']) {
    const f = await fixture(t);
    let confirmed = false;
    f.deps.inspectRecoveryProcesses = async () => ({ owners: [], transports: confirmed && mutate === 'process' ? [{ pid: 33 }] : [] });
    f.deps.confirmRecovery = async () => {
      if (mutate === 'record') await fs.writeFile(path.join(f.directory, 'active.json'), '{"version":3,"entryRevision":0,"currentTargetId":null,"lastTransitionId":null}');
      confirmed = true;
      return true;
    };
    await assert.rejects(acquireWorkingInstance(f.directory, f.deps));
    assert.equal((await readRecord(path.join(f.directory, 'instance.lock'))).value.ownerId, f.owner.ownerId);
  }
});

test('恢复标记阻止正常入口；中断恢复标记可在独占证据下收敛', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, 'recovery-active.json'), JSON.stringify({ ownerId: randomUUID(), pid: 2147483001 }));
  await assert.rejects(acquireInstance(f.directory, f.deps), /恢复/);
  const current = await acquireWorkingInstance(f.directory, f.deps);
  assert.equal(await readRecord(path.join(f.directory, 'recovery-active.json')), null);
  await current.release();
});

test('仅遗留旧 CLI 写入锁也需要显式恢复；不匹配归属不可接管', async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.directory, 'instance.lock'));
  await fs.writeFile(path.join(f.directory, 'operation.lock'), String(f.owner.pid));
  const current = await acquireWorkingInstance(f.directory, f.deps); await current.release();
  await fs.writeFile(path.join(f.directory, 'instance.lock'), JSON.stringify(f.owner));
  await fs.writeFile(path.join(f.directory, 'operation.lock'), String(f.owner.pid + 1));
  await assert.rejects(acquireWorkingInstance(f.directory, f.deps), /不一致/);
});

test('Windows 系统互斥实际排斥另一恢复入口，释放后可重新取得', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  const first = await acquireRecoveryGuard(f.directory);
  try { await assert.rejects(acquireRecoveryGuard(f.directory), /已有恢复/); first.assertOwned(); }
  finally { await first.release(); }
  const next = await acquireRecoveryGuard(f.directory); next.assertOwned(); await next.release();
  const census = await inspectRecoveryProcesses([process.pid]);
  assert.equal(census.owners.some((owner) => owner.pid === process.pid), true);
  assert.equal(Array.isArray(census.transports), true);
});

test('Windows 恢复调用者强制退出后，系统互斥不会永久遗留', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  const code = `import { acquireRecoveryGuard } from ${JSON.stringify(new URL('../scripts/instance-recovery.mjs', import.meta.url).href)}; await acquireRecoveryGuard(${JSON.stringify(f.directory)}); console.log('HELD'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const done = new Promise((resolve) => child.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child guard timeout')), 20_000);
      child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      child.once('error', reject);
    });
    await assert.rejects(acquireRecoveryGuard(f.directory));
  } finally { child.kill(); await done; }
  let guard;
  const deadline = Date.now() + 15_000;
  while (!guard && Date.now() < deadline) {
    try { guard = await acquireRecoveryGuard(f.directory); }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert.ok(guard); await guard.release();
});
