import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { acquireInstance, assertPlainDirectory, createStateStore, readRecord } from './state.mjs';
import { sha256 } from './config.mjs';
import { ExpectedError, runProcess } from './ssh.mjs';

function fail(message) { throw new ExpectedError(message); }
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const id = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function powerShell() {
  if (process.platform !== 'win32' || !process.env.WINDIR) fail('受控锁恢复当前需要 Windows 系统 PowerShell。');
  return path.join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
const encoded = (script) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

// 系统 Mutex 在持有进程崩溃后由 Windows 释放，不产生另一把无法接管的持久锁。
export async function acquireRecoveryGuard(directory) {
  const name = `Global\\CodexRemoteRecovery-${sha256(path.resolve(directory).toLowerCase())}`;
  const script = `$ErrorActionPreference='Stop'; $m=[Threading.Mutex]::new($false,'${name}'); $held=$false; try { try { $held=$m.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held=$true }; if (!$held) { exit 23 }; [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); $null=[Console]::In.ReadLine() } finally { if ($held) { $m.ReleaseMutex() }; $m.Dispose() }`;
  const child = spawn(powerShell(), encoded(script), { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let closed = false;
  const ended = new Promise((resolve) => child.once('close', () => { closed = true; resolve(); }));
  const ready = new Promise((resolve, reject) => {
    let output = '';
    child.once('error', () => reject(new ExpectedError('系统恢复互斥入口无法启动。')));
    child.stdout.on('data', (data) => {
      output += data.toString('utf8');
      if (output === 'READY\r\n' || output === 'READY\n') resolve();
      else if (output.length > 64) reject(new ExpectedError('系统恢复互斥回执无效。'));
    });
    child.once('close', () => reject(new ExpectedError('已有恢复入口，或系统互斥不可用；未接管。')));
  });
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => child.kill(), 20_000);
  try { await ready; } catch (error) { child.kill(); await ended; throw error; } finally { clearTimeout(timer); }
  return {
    assertOwned() { if (closed || child.exitCode !== null || child.signalCode !== null) fail('系统恢复互斥已丢失，停止恢复。'); },
    async release() { if (!closed) child.stdin.end('release\n'); await ended; },
  };
}

// 不收集命令行、环境或终端内容。保守地要求系统中没有 SSH/SCP；不结束任何未知进程。
export async function inspectRecoveryProcesses(pids) {
  if (!Array.isArray(pids) || pids.some((pid) => !positive(pid))) fail('遗留进程身份无效。');
  const list = pids.length ? pids.join(',') : '0';
  const script = `$ErrorActionPreference='Stop'; $ids=@(${list}); $all=@(Get-CimInstance Win32_Process -Filter "Name='ssh.exe' OR Name='scp.exe'"); $owners=@(foreach ($n in $ids) { Get-Process -Id $n -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{pid=$_.Id; startedAt=$_.StartTime.ToUniversalTime().ToString('o')} } }); [pscustomobject]@{ owners=$owners; transports=@($all | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; name=$_.Name; startedAt=$_.CreationDate.ToUniversalTime().ToString('o')} }) } | ConvertTo-Json -Depth 4 -Compress`;
  const result = await runProcess({ executable: powerShell(), args: encoded(script), timeoutMs: 20_000, maxOutputBytes: 128 * 1024 });
  if (result.exitCode !== 0 || result.timedOut || result.outputExceeded) fail('无法取得完整进程证据，未接管遗留锁。');
  let value; try { value = JSON.parse(result.stdout); } catch { fail('系统进程回执无效。'); }
  if (!Array.isArray(value.owners) || !Array.isArray(value.transports)) fail('系统进程证据不完整。');
  return value;
}

function lockOwner(record) {
  if (!record) return null;
  const owner = record.value;
  if (owner.version !== 1 || !id(owner.ownerId) || !positive(owner.pid)
      || typeof owner.processStartedAt !== 'string' || !Number.isFinite(Date.parse(owner.processStartedAt))) fail('实例锁身份格式未知；保留原件。');
  return owner;
}
function operationPid(record, owner) {
  if (!record) return null;
  const value = record.value;
  if (positive(value)) { if (owner && value !== owner.pid) fail('旧写入锁与实例身份不一致。'); return value; }
  if (!owner || !id(value?.writeId) || value.ownerId !== owner.ownerId || value.pid !== owner.pid) fail('写入锁归属不明；保留原件。');
  return value.pid;
}
async function snapshot(directory) {
  const readOnly = { directory: path.resolve(directory), withWriteLock() { fail('锁恢复核对不允许写业务记录。'); } };
  const observed = await createStateStore(directory, readOnly).inspect();
  const instance = await readRecord(path.join(directory, 'instance.lock'));
  const operation = await readRecord(path.join(directory, 'operation.lock'));
  const marker = await readRecord(path.join(directory, 'recovery-active.json'));
  return { instance, operation, marker, records: [observed.entry?.hash ?? null, ...observed.targets.map((entry) => entry.hash).sort()],
    fingerprint: sha256(JSON.stringify([instance?.hash, operation?.hash, marker?.hash, observed.entry?.hash, observed.targets.map((entry) => entry.hash).sort()])) };
}
async function noWriters(state, inspectProcesses) {
  const owner = lockOwner(state.instance), opPid = operationPid(state.operation, owner);
  const priorRecovery = state.marker?.value;
  if (priorRecovery && (!id(priorRecovery.ownerId) || !positive(priorRecovery.pid))) fail('恢复入口身份不明。');
  const pids = [...new Set([owner?.pid, opPid, priorRecovery?.pid].filter(Boolean))];
  const evidence = await inspectProcesses(pids);
  // 即使 PID 被复用也只读停止；不凭时间比较杀进程或抢占。
  if (evidence.owners.length) fail('旧实例、恢复入口仍存活或 PID 已复用；请使用原窗口，未接管。');
  if (evidence.transports.length) fail('仍有 SSH/SCP 进程，无法排除遗留传输。请正常关闭相关连接后重试；工具不会结束它们。');
  return { ownerId: owner?.ownerId ?? null, ownerPid: owner?.pid ?? null, processStartedAt: owner?.processStartedAt ?? null };
}

export async function confirmInstanceRecovery() {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  console.log('发现遗留锁。已核对旧进程不在运行、系统没有 SSH/SCP，且状态可只读核对。');
  console.log('仅接管工具实例和写入锁；不重放配置、远端写入或迁移。后续操作仍需页面预览确认。');
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  const cancel = new AbortController(), interrupt = () => cancel.abort();
  const timer = setTimeout(interrupt, 600_000); timer.unref();
  process.once('SIGINT', interrupt); terminal.once('SIGINT', interrupt);
  try { return (await terminal.question('输入 RECOVER 确认接管，其他内容取消：', { signal: cancel.signal })).trim() === 'RECOVER'; }
  catch { return false; }
  finally { clearTimeout(timer); process.off('SIGINT', interrupt); terminal.close(); }
}

export async function acquireWorkingInstance(directory, dependencies = {}) {
  try { return await acquireInstance(directory, dependencies); }
  catch (error) { if (error.code !== 'INSTANCE_EXISTS') throw error; }
  await assertPlainDirectory(directory);
  const guard = await (dependencies.acquireRecoveryGuard ?? acquireRecoveryGuard)(directory);
  const inspectProcesses = dependencies.inspectRecoveryProcesses ?? inspectRecoveryProcesses;
  let markerOwner = null;
  try {
    guard.assertOwned();
    const before = await snapshot(directory);
    const evidence = await noWriters(before, inspectProcesses);
    if (!before.instance && !before.operation && !before.marker) return await acquireInstance(directory, dependencies);
    const issuedAt = Date.now();
    if ((await (dependencies.confirmRecovery ?? confirmInstanceRecovery)({ title: '确认接管已核对的遗留锁；不重放配置',
      previewRevision: 1, expiresAt: issuedAt + 600_000, choices: ['confirm', 'cancel'] })) !== true) fail('已取消遗留锁接管；原件保留。');
    if (Date.now() - issuedAt > 600_000) fail('锁接管确认已过期；原件保留。');
    guard.assertOwned();
    const checked = await snapshot(directory);
    if (checked.fingerprint !== before.fingerprint) fail('确认后锁或状态已变化，旧确认失效。');
    await noWriters(checked, inspectProcesses);
    guard.assertOwned();
    const owner = { version: 1, ownerId: randomUUID(), pid: process.pid, processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() };
    const markerFile = path.join(directory, 'recovery-active.json');
    // 原恢复入口已确认结束，且 OS 互斥排除了另一恢复者。
    if (checked.marker) await fs.unlink(markerFile);
    await fs.writeFile(markerFile, JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 }); markerOwner = owner.ownerId;
    await fs.writeFile(path.join(directory, `recovery-${owner.ownerId}.json`), JSON.stringify({ version: 1, recoveredAt: new Date().toISOString(),
      previous: evidence, sourceFingerprint: checked.fingerprint, instanceHash: checked.instance?.hash ?? null, operationHash: checked.operation?.hash ?? null,
      records: checked.records, transportCensus: 'no-ssh-or-scp', replayedWrites: false }) + '\n', { flag: 'wx', mode: 0o600 });
    if (checked.operation) await fs.unlink(path.join(directory, 'operation.lock'));
    if (checked.instance) await fs.unlink(path.join(directory, 'instance.lock'));
    return await acquireInstance(directory, { ...dependencies, recoveryOwnerId: owner.ownerId });
  } finally {
    try {
      if (markerOwner) {
        const file = path.join(directory, 'recovery-active.json');
        if ((await readRecord(file))?.value.ownerId === markerOwner) await fs.unlink(file);
      }
    } finally { await guard.release(); }
  }
}
