import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sha256 } from './config.mjs';
import { runProcess } from './ssh.mjs';
import { assertPlainDirectory } from './state.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const productionFiles = Object.freeze([
  'scripts/instance-recovery.mjs',
  'start.cmd', 'package.json', 'package-lock.json', 'docs/CANDIDATE_V0.3.md',
  'runtime/node.exe', 'runtime/LICENSE', 'app/server.mjs', 'app/projection.mjs',
  'app/public/index.html', 'app/public/app.js', 'app/public/style.css',
  ...['e2e', 'config', 'ssh', 'input', 'preflight', 'state', 'legacy-state', 'local-config', 'remote-protocol', 'resources', 'vscode', 'workflow', 'integrity'].map((name) => `scripts/${name}.mjs`),
  'scripts/runtime-manifest.json', 'node_modules/jsonc-parser/package.json', 'node_modules/jsonc-parser/LICENSE.md',
  'node_modules/jsonc-parser/lib/umd/main.js',
  ...['edit', 'format', 'parser', 'scanner', 'string-intern'].map((name) => `node_modules/jsonc-parser/lib/umd/impl/${name}.js`),
]);
async function plainBytes(file) {
  await assertPlainDirectory(path.dirname(file)); const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('打包只接收普通文件。');
  return fs.readFile(file);
}
export async function buildCandidate({ outputDirectory = path.join(root, 'artifacts', 'packages') } = {}) {
  if (process.platform !== 'win32') throw new Error('此候选打包只在 Windows 验证。');
  await fs.mkdir(outputDirectory, { recursive: true }); await assertPlainDirectory(outputDirectory);
  const buildId = randomUUID(), name = `codex-remote-v0.3-candidate-${buildId.slice(0, 8)}`;
  const folder = path.join(outputDirectory, name); await fs.mkdir(folder);
  const runtime = JSON.parse(await plainBytes(path.join(root, 'scripts/runtime-manifest.json')));
  const dependency = JSON.parse(await plainBytes(path.join(root, 'node_modules/jsonc-parser/package.json')));
  const lock = JSON.parse(await plainBytes(path.join(root, 'package-lock.json')));
  if (dependency.version !== '3.3.1' || lock.packages['node_modules/jsonc-parser'].version !== dependency.version) throw new Error('依赖版本不一致。');
  const files = [];
  for (const relative of productionFiles) {
    const bytes = await plainBytes(path.join(root, relative));
    if (relative === 'runtime/node.exe' && sha256(bytes) !== runtime.sha256) throw new Error('固定官方运行时摘要不符。');
    const destination = path.join(folder, relative); await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes, { flag: 'wx' }); files.push({ path: relative, size: bytes.length, sha256: sha256(bytes) });
  }
  const manifest = { version: 1, release: '0.3-candidate-unaccepted', buildId, createdAt: new Date().toISOString(),
    runtime, dependency: { name: dependency.name, version: dependency.version, integrity: lock.packages['node_modules/jsonc-parser'].integrity },
    acceptance: 'pending', files };
  await fs.writeFile(path.join(folder, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  const check = await runProcess({ executable: path.join(folder, 'runtime/node.exe'), args: [path.join(folder, 'scripts/integrity.mjs')], timeoutMs: 30_000 });
  if (check.exitCode !== 0 || check.timedOut) throw new Error('候选内容验证失败。');
  const archive = path.join(outputDirectory, `${name}.zip`);
  const result = await runProcess({ executable: path.join(process.env.WINDIR, 'System32', 'tar.exe'), args: ['-a', '-cf', archive, '-C', outputDirectory, name], timeoutMs: 120_000 });
  if (result.exitCode !== 0 || result.timedOut || result.outputExceeded) throw new Error('ZIP 生成未完成；保留候选目录供核对。');
  const archiveHash = sha256(await plainBytes(archive));
  await fs.writeFile(`${archive}.sha256`, `${archiveHash}  ${path.basename(archive)}\n`, { flag: 'wx' });
  return { folder, archive, archiveHash, fileCount: files.length, acceptance: 'pending' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await buildCandidate(), null, 2)); }
  catch { console.error('候选打包失败；保留已生成目录，不发布未校验 ZIP。'); process.exitCode = 1; }
}
