import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseTree, getNodeValue } from 'jsonc-parser';
import { readLocalConfig } from './local-config.mjs';
import { assertPlainDirectory } from './state.mjs';
import { alias as validateAlias, configPath } from './input.mjs';
import { ExpectedError, runProcess, runSsh, openSshExecutables } from './ssh.mjs';

export const officialGuides = Object.freeze({
  vscode: 'https://code.visualstudio.com/download',
  remoteSsh: 'https://code.visualstudio.com/docs/remote/ssh',
  codex: 'https://learn.chatgpt.com/docs/codex/ide',
  codexMarketplace: 'https://marketplace.visualstudio.com/items?itemName=OpenAI.chatgpt',
  openSsh: 'https://learn.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse',
});
function fail(message) { throw new ExpectedError(message); }
async function jsonFile(file) {
  const { text } = await readLocalConfig(file);
  if (text === null) fail('VS Code 安装元数据缺失。');
  try { return JSON.parse(text); } catch { fail('VS Code 安装元数据不受支持。'); }
}

// 仅识别官方 Windows 安装器的两个已知布局；不执行 code.cmd 或从它提取任意命令。
export async function inspectCodeInstallation(codePath) {
  configPath(codePath);
  if (path.basename(codePath).toLowerCase() !== 'code.exe') fail('请选择正式 VS Code 的 Code.exe。');
  const binary = await fs.lstat(codePath);
  if (!binary.isFile() || binary.isSymbolicLink()) fail('VS Code 入口必须是普通文件。');
  const root = path.dirname(codePath);
  const { text: command } = await readLocalConfig(path.join(root, 'bin', 'code.cmd'));
  const matches = [...(command ?? '').matchAll(/^"%~dp0\.\.\\Code\.exe" "%~dp0\.\.\\((?:[a-f0-9]{10}\\)?resources\\app)\\out\\cli\.js" %\*\r?$/gm)];
  if (matches.length !== 1) fail('VS Code 官方 CLI 布局无法唯一确认。');
  const app = path.join(root, ...matches[0][1].split('\\'));
  await assertPlainDirectory(path.join(app, 'out'));
  const [product, pkg, cli] = await Promise.all([jsonFile(path.join(app, 'product.json')), jsonFile(path.join(app, 'package.json')), fs.lstat(path.join(app, 'out', 'cli.js'))]);
  if (!cli.isFile() || cli.isSymbolicLink() || cli.size > 8 * 1024 * 1024 || product.applicationName !== 'code' || product.quality !== 'stable'
      || !/^[a-f0-9]{40}$/.test(product.commit ?? '') || !/^\d+\.\d+\.\d+$/.test(pkg.version ?? '')) fail('仅支持可核对版本的 VS Code Stable。');
  return { codePath, cliPath: path.join(app, 'out', 'cli.js'), version: pkg.version, commit: product.commit, architecture: 'unverified' };
}

async function codeCli(installation, args, { signal, execute = runProcess } = {}) {
  const result = await execute({ executable: installation.codePath, args: [installation.cliPath, ...args],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' }, signal, timeoutMs: 45_000,
    stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.cancelled || result.timedOut || result.outputExceeded || result.exitCode !== 0) fail('VS Code 官方 CLI 没有完成本次检查。');
  return result.stdout.replace(/\r\n/g, '\n');
}

export async function inspectRemoteSshSettings({ sshConfig, sshPath, settingsPath = process.env.APPDATA && path.join(process.env.APPDATA, 'Code', 'User', 'settings.json') }, dependencies = {}) {
  if (!settingsPath) fail('无法核对 VS Code 用户设置位置。');
  let text;
  try { ({ text } = await (dependencies.readLocalConfig ?? readLocalConfig)(settingsPath)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; text = null; }
  let values = {};
  if (text !== null) {
    const errors = [], tree = parseTree(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
    if (errors.length || tree?.type !== 'object') fail('VS Code 用户设置无法安全解析；未展示正文。');
    const relevant = new Set(['remote.SSH.configFile', 'remote.SSH.path', 'remote.SSH.serverInstallPath']);
    const seen = new Set();
    for (const property of tree.children ?? []) {
      const key = property.children[0].value;
      if (!relevant.has(key)) continue;
      if (seen.has(key)) fail('VS Code SSH 设置重复，无法核对有效入口。');
      seen.add(key); values[key] = getNodeValue(property.children[1]);
    }
  }
  const expand = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value !== 'string') fail('VS Code SSH 路径不是字符串。');
    return configPath(value.replace(/^~(?=[\\/])/, os.homedir()));
  };
  const actualConfig = expand(values['remote.SSH.configFile'], path.join(os.homedir(), '.ssh', 'config'));
  const actualSsh = expand(values['remote.SSH.path'], sshPath);
  const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
  const issues = [];
  if (!samePath(actualConfig, sshConfig)) issues.push('ssh-config-entry');
  if (!samePath(actualSsh, sshPath)) issues.push('openssh-entry');
  const install = values['remote.SSH.serverInstallPath'];
  if (install !== undefined && (!install || typeof install !== 'object' || Array.isArray(install) || Object.keys(install).length)) issues.push('server-install-path');
  return { ready: !issues.length, issues, profile: 'default-stable', sshConfig: actualConfig, sshPath: actualSsh };
}

export async function detectLocalTools({ codePath, sshConfig = path.join(os.homedir(), '.ssh', 'config'), signal } = {}, dependencies = {}) {
  configPath(sshConfig);
  const candidates = codePath ? [codePath] : [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
  ].filter(Boolean);
  const inspect = dependencies.inspectCodeInstallation ?? inspectCodeInstallation;
  const execute = dependencies.runProcess ?? runProcess;
  let installation;
  for (const candidate of candidates) {
    try { installation = await inspect(candidate); break; }
    catch (error) { if (codePath || error.code !== 'ENOENT') throw error; }
  }
  if (!installation) return { ready: false, missing: ['vscode'], guides: officialGuides, sshConfig };
  const versionText = await codeCli(installation, ['--version'], { signal, execute });
  const version = versionText.trim().split('\n');
  if (version.length !== 3 || version[0] !== installation.version || version[1] !== installation.commit || version[2] !== 'x64') fail('运行中的 VS Code CLI 版本/架构与安装依据不一致。');
  const extensions = await codeCli(installation, ['--list-extensions', '--show-versions'], { signal, execute });
  const remoteSsh = extensions.split('\n').filter((line) => /^ms-vscode-remote\.remote-ssh@\d+\.\d+\.\d+$/.test(line));
  if (remoteSsh.length > 1) fail('Remote SSH 版本不能唯一确定。');
  const tools = openSshExecutables();
  const ssh = await execute({ executable: tools.ssh, args: ['-V'], signal, timeoutMs: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const curl = await execute({ executable: process.platform === 'win32' ? path.join(process.env.WINDIR, 'System32', 'curl.exe') : 'curl', args: ['--disable', '--version'], signal,
    timeoutMs: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const missing = [];
  if (ssh.exitCode !== 0 || ssh.cancelled || ssh.timedOut || ssh.outputExceeded || !/^OpenSSH[^\r\n]+/m.test(ssh.stderr + ssh.stdout)) missing.push('openssh');
  if (curl.exitCode !== 0 || curl.cancelled || curl.timedOut || curl.outputExceeded || !/^curl \d+\.\d+\.\d+/.test(curl.stdout)) missing.push('curl');
  if (!remoteSsh.length) missing.push('remote-ssh');
  const alignment = await (dependencies.inspectRemoteSshSettings ?? inspectRemoteSshSettings)({ sshConfig, sshPath: tools.ssh });
  if (!alignment.ready) missing.push(...alignment.issues);
  return { ready: missing.length === 0, missing, guides: officialGuides, sshConfig,
    vscode: { ...installation, architecture: 'x64' }, remoteSshVersion: remoteSsh[0]?.split('@')[1] ?? null,
    sshPath: tools.ssh, scpPath: tools.scp, alignment };
}

export function serverPreparationInstructions({ alias, sshConfig, remoteSshVersion }) {
  validateAlias(alias); configPath(sshConfig);
  return { stage: 'server', choices: ['ready', 'later'], title: '在 VS Code 连接目标容器',
    steps: [`确认 Remote SSH 使用 ${sshConfig}，并在“Remote-SSH: Connect to Host…”选择 ${alias}。`,
      '在官方窗口完成主机确认和认证，等待远端窗口打开。下载失败时查看 Remote SSH 输出。',
      '完成后返回点击“重新检查”；工具会核对实际服务端进程，点击本身不代表安装成功。'],
    guide: officialGuides.remoteSsh, remoteSshVersion,
    download: { serverDomains: ['update.code.visualstudio.com', 'vscode.download.prss.microsoft.com'],
      policy: 'Remote SSH 默认远端下载，失败后本机下载并传输；不修改下载设置。' } };
}

// 只从当前 UID 的、与本机 commit 对应的实际 server-main 进程取得标准路径依据。
const SERVER_SCRIPT = String.raw`
set -eu
commit=$1
home=$2
[ "$HOME" = "$home" ] || exit 47
root="$home/.vscode-server"
count=0
selected=
for file in /proc/[0-9]*/cmdline; do
  [ -r "$file" ] || continue
  pid=$(printf '%s' "$file" | awk -F/ '{print $3}')
  [ "$(awk '/^Uid:/ {print $2; exit}' "/proc/$pid/status" 2>/dev/null || true)" = "$(id -u)" ] || continue
  executable=$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)
  case "$executable" in "$root/bin/$commit/node"|"$root/cli/servers/Stable-$commit/server/node") ;; *) continue;; esac
  base=$(dirname "$executable")
  tr '\000' '\n' < "$file" 2>/dev/null | grep -qxF -- "$base/out/server-main.js" || continue
  # 接受显式的标准目录，拒绝重复、缺值或自定义目录；不展示任意进程参数。
  if ! tr '\000' '\n' < "$file" | awk -v root="$root" '
    function check(key,value) {
      if (seen[key]++) bad=1
      expected=(key=="--server-data-dir" ? root : key=="--user-data-dir" ? root "/data" : root "/extensions")
      if (value!=expected) bad=1
    }
    { if (pending!="") { check(pending,$0); pending=""; next }
      if ($0 ~ /^--(server-data-dir|user-data-dir|extensions-dir)=/) {
        split($0,parts,"="); check(parts[1],substr($0,length(parts[1])+2))
      } else if ($0 ~ /^--(server-data-dir|user-data-dir|extensions-dir)$/) pending=$0
    } END { if (bad || pending!="") exit 1 }'; then
    printf '__CODEX_SERVER_V1__\nstatus=nonstandard\n'; exit 0
  fi
  count=$((count + 1)); selected=$pid
done
if [ "$count" -eq 0 ]; then printf '__CODEX_SERVER_V1__\nstatus=missing\n'; exit 0; fi
if [ "$count" -ne 1 ]; then printf '__CODEX_SERVER_V1__\nstatus=ambiguous\n'; exit 0; fi
folder="$root/data/Machine"
current="$folder"
while [ "$current" != / ]; do
  [ -d "$current" ] && [ ! -L "$current" ] || exit 47
  current=$(dirname "$current")
done
[ "$(stat -c %u "$folder")" = "$(id -u)" ] && [ -w "$folder" ] || exit 47
printf '__CODEX_SERVER_V1__\nstatus=ready\npid=%s\ncommit=%s\nsettings=%s\n' "$selected" "$commit" "$(printf '%s' "$folder/settings.json" | base64 | tr -d '\n')"
`;

export async function locateRemoteServer(options, { home, commit }, dependencies = {}) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '') || typeof home !== 'string' || !home.startsWith('/') || /[\x00-\x1f\x7f]/.test(home)) fail('缺少当前用户和 VS Code commit 依据。');
  const output = (await (dependencies.runSsh ?? runSsh)(options, SERVER_SCRIPT, [commit, home], 60_000, 'sh', '核对实际 VS Code Server')).replace(/\r\n/g, '\n');
  const stopped = output.match(/^__CODEX_SERVER_V1__\nstatus=(missing|ambiguous|nonstandard)\n$/);
  if (stopped) return { status: stopped[1], settingsPath: null };
  const match = output.match(/^__CODEX_SERVER_V1__\nstatus=ready\npid=([1-9]\d*)\ncommit=([a-f0-9]{40})\nsettings=([A-Za-z0-9+/]+={0,2})\n$/);
  if (!match || match[2] !== commit) fail('Server 路径核对证据不完整；原始输出未展示。');
  const bytes = Buffer.from(match[3], 'base64');
  let settingsPath;
  try { settingsPath = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('Server 路径编码不受支持。'); }
  if (bytes.toString('base64') !== match[3] || settingsPath !== `${home}/.vscode-server/data/Machine/settings.json`) fail('Server settings 路径与已确认标准布局不一致。');
  return { status: 'ready', settingsPath, serverPid: Number(match[1]), commit, pathEvidence: 'running-server-current-user' };
}
