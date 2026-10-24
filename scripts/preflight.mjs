import { runSsh, ExpectedError } from './ssh.mjs';

// 不访问 Server、扩展或 settings；可在刚创建的 Linux 容器执行。
const BASIC_SCRIPT = String.raw`
set -eu
[ "$(uname -s)" = Linux ] || exit 44
for tool in sh bash curl base64 sha256sum mktemp mkdir mv cp ln rm rmdir sync cat chmod stat dirname basename find grep awk tr cut readlink date sleep id uname getconf; do
  command -v "$tool" >/dev/null 2>&1 || { printf '__CODEX_BASIC_V1__\nmissing=%s\n' "$tool"; exit 44; }
done
listener_tool=
for candidate in ss netstat; do
  if command -v "$candidate" >/dev/null 2>&1; then listener_tool=$candidate; break; fi
done
if [ -z "$listener_tool" ] && [ -r /proc/net/tcp ]; then listener_tool=proc; fi
[ -n "$listener_tool" ] || { printf '__CODEX_BASIC_V1__\nmissing=socket-inspection\n'; exit 44; }
[ -d "$HOME" ] && [ ! -L "$HOME" ] && [ -w "$HOME" ] || exit 44
distro=unknown
release=unknown
if [ -r /etc/os-release ]; then
  distro=$(awk -F= '$1=="ID" {gsub(/"/,"",$2); print $2; exit}' /etc/os-release)
  release=$(awk -F= '$1=="VERSION_ID" {gsub(/"/,"",$2); print $2; exit}' /etc/os-release)
fi
printf '__CODEX_BASIC_V1__\narchitecture=%s\nuid=%s\nhome=%s\ndistribution=%s\nrelease=%s\nlibc=%s\nlistener=%s\n' \
  "$(uname -m)" "$(id -u)" "$(printf '%s' "$HOME" | base64 | tr -d '\n')" "$distro" "$release" "$(getconf GNU_LIBC_VERSION)" "$listener_tool"
`;

export async function preflightRemoteBase(options, dependencies = {}) {
  const execute = dependencies.runSsh ?? runSsh;
  const text = (await execute(options, BASIC_SCRIPT, [], 60_000, 'sh', '检查 Linux 基础环境', [44])).replace(/\r\n/g, '\n');
  const missing = text.match(/^__CODEX_BASIC_V1__\nmissing=([a-z0-9_-]+)\n$/)?.[1];
  if (missing) throw new ExpectedError(`远端缺少必需工具：${missing}；尚未写入配置。`);
  const match = text.match(/^__CODEX_BASIC_V1__\narchitecture=(x86_64|aarch64)\nuid=(0|[1-9]\d*)\nhome=([A-Za-z0-9+/]+={0,2})\ndistribution=([a-z0-9_-]+)\nrelease=([a-zA-Z0-9._-]+)\nlibc=glibc (\d+\.\d+)\nlistener=(ss|netstat|proc)\n$/);
  if (!match) throw new ExpectedError('远端基础环境结果不受支持；原始输出未展示。');
  const bytes = Buffer.from(match[3], 'base64');
  let home;
  try { home = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* 固定错误 */ }
  if (bytes.toString('base64') !== match[3] || !home?.startsWith('/') || /[\x00-\x1f\x7f]/.test(home)) throw new ExpectedError('远端 home 路径无法确认。');
  return { architecture: match[1], uid: Number(match[2]), home, distribution: match[4], release: match[5], libc: match[6], listenerTool: match[7],
    transfer: 'unverified', forwarding: 'unverified' };
}
