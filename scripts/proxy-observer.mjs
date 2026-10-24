import { runSsh, ExpectedError } from './ssh.mjs';

// 有限只读采集：只输出已核对进程拥有的、到指定 IPv4 回环代理的新连接。
// 不产生 curl/模型流量，不读取进程环境、请求正文或其他连接的地址。
export const PROXY_OBSERVER_SCRIPT = String.raw`
set -eu
pid=$1; port=$2; extension_name=$3; seconds=$4
unknown() { printf '__CODEX_PROXY_V1__\nstatus=%s\n' "$1"; exit 0; }
folder="$HOME/.vscode-server/extensions/$extension_name"
[ -d "$folder" ] && [ ! -L "$folder" ] || unknown identity-unverified
folder=$(readlink -f "$folder") || unknown identity-unverified
uid=$(id -u)
identity() {
  [ "$(awk '/^Uid:/ {print $2; exit}' "/proc/$pid/status" 2>/dev/null)" = "$uid" ] || return 1
  executable=$(readlink -f "/proc/$pid/exe" 2>/dev/null) || return 1
  case "$executable" in "$folder"/*/codex) ;; *) return 1;; esac
  tr '\000' '\n' < "/proc/$pid/cmdline" 2>/dev/null | grep -qxF -- app-server || return 1
  ticks=$(sed 's/^.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $20}')
  case "$ticks" in ''|*[!0-9]*) return 1;; esac
}
identity || unknown identity-unverified
started=$ticks
peer=$(printf '0100007F:%04X' "$port")
owned_connections() {
  [ -r "/proc/$pid/fd" ] && [ -x "/proc/$pid/fd" ] && [ -r "/proc/$pid/net/tcp" ] || return 1
  inodes=; descriptors=0
  for fd in /proc/"$pid"/fd/*; do
    descriptors=$((descriptors + 1)); [ "$descriptors" -le 4096 ] || return 1
    link=$(readlink "$fd" 2>/dev/null || true)
    case "$link" in socket:\[*\]) inode=$(printf %s "$link" | sed -n 's/^socket:\[\([0-9]*\)\]$/\1/p')
      case "$inode" in ''|*[!0-9]*) return 1;; esac
      inodes="$inodes $inode";;
    esac
  done
  awk -v owned=" $inodes " -v peer="$peer" '$3==peer && $4=="01" && index(owned," "$10" ") {print $10}' "/proc/$pid/net/tcp"
}
baseline=$(owned_connections) || unknown unavailable
baseline=$(printf '%s\n' "$baseline" | tr '\n' ' ')
identity && [ "$ticks" = "$started" ] || unknown process-changed
baseline_count=$(printf %s "$baseline" | awk '{print NF}')
printf '只读采集已开始；请现在在目标 Codex 发送一次请求。采集期间不要运行其他网络探针。\n' >&2
sample=0; first=0; selected=0; limit=$((seconds * 4))
deadline=$(( $(date +%s) + seconds ))
while [ "$sample" -lt "$limit" ]; do
  sleep 0.25
  sample=$((sample + 1))
  identity && [ "$ticks" = "$started" ] || unknown process-changed
  connections=$(owned_connections) || unknown unavailable
  identity && [ "$ticks" = "$started" ] || unknown process-changed
  if [ "$selected" = 0 ]; then
    for inode in $connections; do
      case " $baseline " in *" $inode "*) ;; *) selected=$inode; first=$sample; break;; esac
    done
  fi
  [ "$(date +%s)" -lt "$deadline" ] || break
done
status=no-new-connection
[ "$selected" = 0 ] || status=connection-observed
printf '__CODEX_PROXY_V1__\nstatus=%s\npid=%s\nstart=%s\nport=%s\nsamples=%s\nbaseline=%s\ninode=%s\nfirst=%s\n' "$status" "$pid" "$started" "$port" "$sample" "$baseline_count" "$selected" "$first"
`;

function fail() { throw new ExpectedError('代理连接采集证据无效；原始输出未展示。'); }
export function observerParameters({ pid, remotePort, version, architecture, seconds = 60 }) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535
      || !/^\d{1,4}\.\d{1,6}\.\d{1,6}$/.test(version ?? '') || !['x86_64', 'aarch64'].includes(architecture)
      || !Number.isInteger(seconds) || seconds < 1 || seconds > 120) fail();
  return [String(pid), String(remotePort), `openai.chatgpt-${version}-linux-${architecture === 'x86_64' ? 'x64' : 'arm64'}`, String(seconds)];
}

export function parseObservation(output, options) {
  observerParameters(options);
  if (typeof output !== 'string' || output.length > 2048) fail();
  const text = output.replace(/\r\n/g, '\n');
  const unknown = text.match(/^__CODEX_PROXY_V1__\nstatus=(identity-unverified|process-changed|unavailable)\n$/);
  if (unknown) return { status: 'unknown', reason: unknown[1] };
  const match = text.match(/^__CODEX_PROXY_V1__\nstatus=(connection-observed|no-new-connection)\npid=([1-9]\d*)\nstart=([1-9]\d{0,19})\nport=(\d+)\nsamples=(\d+)\nbaseline=(\d+)\ninode=(0|[1-9]\d{0,19})\nfirst=(\d+)\n$/);
  if (!match) fail();
  const [, status, pid, startTicks, remotePort, samples, baseline, inode, first] = match;
  const expectedSamples = (options.seconds ?? 60) * 4;
  if (pid !== String(options.pid) || remotePort !== String(options.remotePort) || !Number.isInteger(Number(samples))
      || Number(samples) < 1 || Number(samples) > expectedSamples
      || !Number.isInteger(Number(baseline)) || Number(baseline) > 4096 || Number(first) > expectedSamples
      || Number(first) > Number(samples) || status === 'connection-observed' && (inode === '0' || Number(first) < 1)
      || status === 'no-new-connection' && (inode !== '0' || first !== '0')) fail();
  return { status: status === 'connection-observed' ? 'observed' : 'unknown', reason: status,
    pid: options.pid, processStartTicks: startTicks, remotePort: options.remotePort, samples: Number(samples),
    baselineConnections: Number(baseline), newSocketInode: inode === '0' ? null : inode,
    firstSeenSample: first === '0' ? null : Number(first) };
}

export async function observeProxyConnection(transport, options, dependencies = {}) {
  const parameters = observerParameters(options);
  const output = await (dependencies.runSsh ?? runSsh)(transport, PROXY_OBSERVER_SCRIPT, parameters,
    (Number(parameters[3]) + 15) * 1000, 'sh', '只读观察目标进程到代理的新连接');
  return parseObservation(output, options);
}
