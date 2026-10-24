import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPlainDirectory } from './state.mjs';
import { configPath } from './input.mjs';
import { contentSnapshot, restrictWindowsDirectory } from './config.mjs';
import { ExpectedError, runProcess } from './ssh.mjs';

const MAX_BYTES = 1024 * 1024;
function fail(message) { throw new ExpectedError(message); }
function matches(left, right) { return left?.exists === right?.exists && left?.sha256 === right?.sha256; }

async function inspectParent(filePath) {
  const parent = path.dirname(filePath);
  try { await assertPlainDirectory(parent); return false; }
  catch (error) {
    // 只允许新建一个明确的 .ssh/config 父目录；不递归创建任意路径。
    if (error.code !== 'ENOENT' || path.basename(parent) !== '.ssh' || path.basename(filePath) !== 'config') throw error;
    await assertPlainDirectory(path.dirname(parent));
    const current = await fs.lstat(parent).catch((failure) => { if (failure.code !== 'ENOENT') throw failure; return null; });
    if (current) { await assertPlainDirectory(parent); return false; }
    return true;
  }
}

export async function readLocalConfig(filePath) {
  configPath(filePath);
  if (await inspectParent(filePath)) return { text: null, snapshot: contentSnapshot(null), identity: null, parentMissing: true };
  const stat = await fs.lstat(filePath, { bigint: true }).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!stat) return { text: null, snapshot: contentSnapshot(null), identity: null };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail('本机配置类型或大小不受支持。');
  const handle = await fs.open(filePath, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > MAX_BYTES) fail('读取时本机配置已变化。');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_BYTES) fail('本机配置过大。');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset)); }
    catch { fail('本机配置不是受支持的 UTF-8；未展示原始内容。'); }
    if (text.includes('\0')) fail('本机配置包含不受支持的编码。');
    return { text, snapshot: contentSnapshot(text), identity: { ino: stat.ino.toString(), dev: stat.dev.toString(), mode: Number(stat.mode) } };
  } finally { await handle.close(); }
}

// 只有持实例锁和 operation.lock 的调用方可以提交；本函数不发起确认或建立恢复意图。
export async function writeLocalPlan(plan, lease, { stageDirectory, onStageCreated = async () => {}, beforePublish = async () => {} } = {}) {
  if (typeof lease?.assertOwned !== 'function') fail('缺少当前写入锁。');
  await lease.assertOwned();
  if (!matches(contentSnapshot(plan.text), plan.expectedAfter)) fail('配置计划内容与摘要不一致。');
  if (await inspectParent(plan.path)) {
    if (plan.kind !== 'connection' || plan.expectedBefore.exists || plan.text === null) fail('只有新建连接计划可创建 .ssh 目录。');
    await lease.assertOwned();
    let created = false;
    try { await fs.mkdir(path.dirname(plan.path), { mode: 0o700 }); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await assertPlainDirectory(path.dirname(plan.path));
    if (created && process.platform === 'win32') await restrictWindowsDirectory(path.dirname(plan.path), { runProcess });
  }
  const before = await readLocalConfig(plan.path);
  if (!matches(before.snapshot, plan.expectedBefore)) fail('确认后本机配置已变化；未覆盖用户修改。');
  if (matches(before.snapshot, plan.expectedAfter)) return before.snapshot;
  let temporary = null, staging = null, handle = null;
  try {
    if (plan.text !== null) {
      if (typeof stageDirectory !== 'string' || path.dirname(stageDirectory) !== path.dirname(plan.path)
          || !/^\.codex-write-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(path.basename(stageDirectory))) fail('缺少已预存的本机暂存定位。');
      await fs.mkdir(stageDirectory, { mode: 0o700 });
      // 只有独占创建成功，才取得收尾权；不能删除碰巧同名的已有目录。
      staging = stageDirectory;
      if (process.platform === 'win32') await restrictWindowsDirectory(staging, { runProcess });
      const identity = await fs.lstat(staging, { bigint: true });
      await onStageCreated({ ino: identity.ino.toString(), dev: identity.dev.toString() });
      temporary = path.join(staging, 'content.tmp');
      handle = await fs.open(temporary, 'wx', before.identity?.mode ?? 0o600);
      await handle.writeFile(plan.text, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    }
    await beforePublish(); await lease.assertOwned();
    const current = await readLocalConfig(plan.path);
    if (!matches(current.snapshot, plan.expectedBefore) || (before.identity && (before.identity.ino !== current.identity?.ino || before.identity.dev !== current.identity?.dev))) fail('替换前本机配置已变化；未覆盖用户修改。');
    if (plan.text === null) await fs.unlink(plan.path);
    else if (before.snapshot.exists) await fs.rename(temporary, plan.path);
    else await fs.link(temporary, plan.path); // 不覆盖晚到的新文件。
    const after = await readLocalConfig(plan.path);
    if (!matches(after.snapshot, plan.expectedAfter)) fail('本机配置提交后复读不符；保留恢复意图。');
    return after.snapshot;
  } finally {
    if (handle) await handle.close();
    if (temporary) await fs.rm(temporary, { force: true });
    if (staging) await fs.rmdir(staging);
  }
}

// 仅用于原实例/本机同步动作已结束后的收尾；不按目录名推定所有权。
export async function cleanupLocalStage(directory, identity, filename) {
  await assertPlainDirectory(path.dirname(directory));
  const stat = await fs.lstat(directory, { bigint: true }).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!stat) return true;
  if (!identity || !stat.isDirectory() || stat.isSymbolicLink() || stat.ino.toString() !== identity.ino || stat.dev.toString() !== identity.dev) return false;
  const names = await fs.readdir(directory);
  if (names.some((name) => name !== filename)) return false;
  const file = path.join(directory, filename);
  const payload = await fs.lstat(file).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
  if (payload && (!payload.isFile() || payload.isSymbolicLink())) return false;
  if (payload) await fs.unlink(file);
  await fs.rmdir(directory); return true;
}
