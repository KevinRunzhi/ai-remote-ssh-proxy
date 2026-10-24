import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
export async function verifyBundle() {
  const file = path.join(root, 'build-manifest.json');
  const stat = await fs.lstat(file).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!stat) return { development: true };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000) throw new Error('清单类型无效。');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 100
      || process.platform !== 'win32' || process.arch !== 'x64' || process.version !== `v${manifest.runtime.version}`) throw new Error('包平台/运行时不一致。');
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(entry.path) || entry.path.split('/').includes('..')) throw new Error('包清单路径无效。');
    let current = root;
    const parts = entry.path.split('/');
    for (const part of parts.slice(0, -1)) { current = path.join(current, part); const parent = await fs.lstat(current); if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('包包含目录链接。'); }
    const target = path.join(root, entry.path), currentStat = await fs.lstat(target);
    if (!currentStat.isFile() || currentStat.isSymbolicLink() || currentStat.size !== entry.size) throw new Error('包文件大小/类型变化。');
    const digest = createHash('sha256').update(await fs.readFile(target)).digest('hex');
    if (digest !== entry.sha256) throw new Error('包文件摘要变化。');
  }
  return { development: false, buildId: manifest.buildId };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await verifyBundle(); console.log('候选文件完整性核对通过；不代表功能验收。'); }
  catch { console.error('候选文件或运行时核对失败，请重新取得完整工具包。'); process.exitCode = 1; }
}
