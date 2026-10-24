import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './config.mjs';
import { runProcess } from './ssh.mjs';
import os from 'node:os';
import { normalizeProxy } from './input.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const runtimeManifest = JSON.parse(await fs.readFile(new URL('./runtime-manifest.json', import.meta.url), 'utf8'));

async function download(url, limit, label, proxyArgs = []) {
  const seconds = limit > 1024 * 1024 ? 900 : 60;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-runtime-'));
  const file = path.join(temporary, 'download');
  try {
    const result = await runProcess({
      executable: process.platform === 'win32' ? path.join(process.env.WINDIR, 'System32', 'curl.exe') : 'curl',
      args: ['--disable', '--fail', '--silent', '--show-error', ...proxyArgs, '--proto', '=https', '--connect-timeout', '10', '--retry', '2', '--retry-all-errors', '--retry-max-time', String(seconds), '--max-time', String(seconds), '--max-filesize', String(limit), '--output', file, url],
      timeoutMs: (seconds + 5) * 1000,
    });
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`${label}下载失败（curl ${result.exitCode ?? '未知'}${result.timedOut ? '，超时' : ''}）。`);
    if ((await fs.stat(file)).size > limit) throw new Error('官方下载超过大小限制。');
    return await fs.readFile(file);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export async function prepareRuntime(directory = path.join(root, 'runtime'), { localProxy } = {}) {
  const manifest = runtimeManifest;
  const proxyArgs = localProxy === undefined ? [] : ['--proxy', normalizeProxy(localProxy).localProxy, '--noproxy', ''];
  // 固定可信摘要还须与精确版本官方清单吻合；不能仅信任本次下载结果。
  const sums = (await download(manifest.checksumsUrl, 100_000, '官方校验清单', proxyArgs)).toString('utf8');
  if (!sums.split(/\r?\n/).includes(`${manifest.sha256}  win-x64/node.exe`)) throw new Error('官方清单与固定运行时摘要不一致。');
  if (!sums.split(/\r?\n/).includes(`${manifest.archiveSha256}  node-v${manifest.version}-win-x64.zip`)) throw new Error('官方清单与固定压缩包摘要不一致。');
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('运行时目录不安全。');
  const binaryPath = path.join(directory, 'node.exe');
  const existing = await fs.lstat(binaryPath).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || sha256(await fs.readFile(binaryPath)) !== manifest.sha256)) throw new Error('已有运行时摘要不匹配，未覆盖。');
  if (!existing) {
    // 官方 ZIP 更小；先验证整包，再仅解出指定成员，最终仍核对独立 node.exe 摘要。
    const archive = await download(manifest.archiveUrl, 100 * 1024 * 1024, '官方 Node 压缩包', proxyArgs);
    if (sha256(archive) !== manifest.archiveSha256) throw new Error('运行时压缩包摘要不匹配。');
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-runtime-extract-'));
    try {
      const archivePath = path.join(temporary, 'runtime.zip');
      await fs.writeFile(archivePath, archive, { flag: 'wx' });
      const extracted = await runProcess({ executable: process.platform === 'win32' ? path.join(process.env.WINDIR, 'System32', 'tar.exe') : 'tar',
        args: ['-xf', archivePath, '-C', temporary, manifest.archiveBinary], timeoutMs: 60_000 });
      if (extracted.exitCode !== 0 || extracted.timedOut) throw new Error('官方压缩包解包失败。');
      const member = path.join(temporary, manifest.archiveBinary);
      const stat = await fs.lstat(member);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 150 * 1024 * 1024) throw new Error('官方运行时成员类型异常。');
      const binary = await fs.readFile(member);
      if (sha256(binary) !== manifest.sha256) throw new Error('运行时摘要不匹配。');
      await fs.writeFile(binaryPath, binary, { flag: 'wx' });
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
  const license = await download(manifest.licenseUrl, 1024 * 1024, '官方许可证', proxyArgs);
  // 独占写入，已有资源不能被下载命令覆盖。
  for (const [name, content] of [['LICENSE', license]]) {
    const dest = path.join(directory, name);
    try { await fs.writeFile(dest, content, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = await fs.lstat(dest);
      if (!current.isFile() || current.isSymbolicLink() || sha256(await fs.readFile(dest)) !== sha256(content)) {
        throw new Error('已有运行时资源不同，未覆盖。');
      }
    }
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await prepareRuntime();
    console.log(`已准备并校验 Node ${runtimeManifest.version} Windows x64 候选运行时。`);
  } catch {
    console.error('运行时准备失败；检查官方网络与 runtime 目录，未放宽 TLS 或覆盖已有资源。');
    process.exitCode = 1;
  }
}
