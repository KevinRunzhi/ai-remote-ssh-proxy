// 仅维护者：解压真实候选 ZIP 后用随包 Node 验证；不接触用户状态。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './ssh.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const result = JSON.parse(await fs.readFile(path.join(root, 'artifacts/package-current.log'), 'utf8'));
const directory = path.join(root, 'artifacts', `包 测试 &!%() ${Date.now()}`);
await fs.mkdir(directory);
const tar = await runProcess({ executable: path.join(process.env.WINDIR, 'System32/tar.exe'), args: ['-xf', result.archive, '-C', directory], timeoutMs: 60_000 });
if (tar.exitCode !== 0 || tar.timedOut) throw new Error('解包失败');
const folder = path.join(directory, path.basename(result.folder)), binary = path.join(folder, 'runtime/node.exe');
const execute = (script, args = []) => runProcess({ executable: binary, args: [path.join(folder, script), ...args],
  env: { ...process.env, PATH: '', LOCALAPPDATA: directory }, timeoutMs: 30_000 });
let response = await execute('scripts/integrity.mjs');
if (response.exitCode !== 0) throw new Error('特殊路径包核对失败');
response = await execute('scripts/e2e.mjs', ['verify']);
if (response.exitCode !== 1 || !response.stdout.includes('原生交互终端')) throw new Error('CLI 无 TTY 未明确停止');
response = await execute('app/server.mjs');
if (response.exitCode !== 1 || !response.stderr.includes('原生交互终端')) throw new Error('网页无 TTY 未明确停止');
if ((await fs.readdir(directory)).length !== 1) throw new Error('拒绝启动时不应创建用户状态');
const asset = path.join(folder, 'app/public/index.html'), bytes = await fs.readFile(asset);
await fs.appendFile(asset, 'tamper');
response = await execute('scripts/integrity.mjs');
await fs.writeFile(asset, bytes);
if (response.exitCode !== 1) throw new Error('未拒绝已损坏资源');
const manifest = JSON.parse(await fs.readFile(path.join(folder, 'build-manifest.json'), 'utf8'));
if (manifest.files.some((entry) => /(?:trial|fixture|legacy-cli|tests|active\.json|\.cache)/.test(entry.path))) throw new Error('候选包含开发表面或状态');
console.log(JSON.stringify({ folder, checks: ['zip-extraction', 'special-path', 'no-PATH-node', 'no-TTY-no-state', 'tamper-rejected', 'production-whitelist'], status: 'pass',
  limitations: ['未进行真实双击 TTY 和普通用户身份验证', '不是首次安装和 A→B 验收'] }, null, 2));
