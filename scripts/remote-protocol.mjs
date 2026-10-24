import path from 'node:path';
import { sha256 } from './config.mjs';
import { runSsh, ExpectedError } from './ssh.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
function fail(message) { throw new ExpectedError(message); }
function linuxPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value === '/' || value.length > 2048
      || /[\x00-\x1f\x7f]/.test(value) || value.endsWith('/') || path.posix.normalize(value) !== value) fail('远端协议路径不受支持。');
  return value;
}
function snapshotHash(value) {
  if (!value || typeof value.exists !== 'boolean' || (value.exists ? typeof value.sha256 !== 'string' || !HASH.test(value.sha256) : value.sha256 !== null)) fail('远端写入摘要无效。');
  return value.exists ? value.sha256 : 'missing';
}

// 该对象及 stageRef 必须先保存为 pendingWrite，调用方才能 allocate / 上传 / write。
// 请求仅含身份、路径和摘要，配置正文只能通过受限文件传输进入 payload。
export function planRemoteWrite({ operationId, writeId, action, stageParent, targetPath, expectedBefore, expectedAfter, mode = '600' }) {
  if (typeof operationId !== 'string' || typeof writeId !== 'string' || !UUID.test(operationId) || !UUID.test(writeId) || !['apply', 'restore', 'cleanup'].includes(action)) fail('远端写入身份无效。');
  linuxPath(stageParent); linuxPath(targetPath);
  if (!/^0?[0-7]{3}$/.test(mode)) fail('远端配置权限不受支持。');
  const before = snapshotHash(expectedBefore), after = snapshotHash(expectedAfter);
  if (after === 'missing' && action === 'apply') fail('apply 不能删除配置。');
  const normalizedMode = Number.parseInt(mode, 8).toString(8).padStart(3, '0');
  const request = ['v1', operationId, writeId, action, Buffer.from(targetPath).toString('base64'), before, after, normalizedMode].join('\n') + '\n';
  return { operationId, writeId, request, requestHash: sha256(request),
    stageRef: { directory: path.posix.join(stageParent, `.codex-remote-write-${writeId}`),
      commitDirectory: path.posix.join(path.posix.dirname(targetPath), `.codex-remote-commit-${writeId}`), requestHash: sha256(request) } };
}

// Linux 专用固定协议。异常退出不释放 guard；不设置无条件清理 trap。
export const REMOTE_PROTOCOL_SCRIPT = String.raw`
set -eu
umask 077
verb=$1
stage=$2
request_hash=$3
emit() { printf '__CODEX_WRITE_V1__\nstatus=%s\npermit=%s\nactual=%s\n' "$1" "$2" "$3"; }
plain_dir() {
  case "$1" in /*) ;; *) exit 47;; esac
  current=
  saved_ifs=$IFS
  IFS=/
  set -f
  set -- $1
  IFS=$saved_ifs
  for component do
    [ -n "$component" ] || continue
    case "$component" in .|..) exit 47;; esac
    current="$current/$component"
    [ ! -L "$current" ] && [ -d "$current" ] || exit 47
  done
}
for tool in awk base64 sha256sum stat id mkdir dirname basename cp chmod mv ln rm rmdir sync cat; do command -v "$tool" >/dev/null 2>&1 || exit 44; done
parent=$(dirname "$stage")
plain_dir "$parent"
stage_name=$(basename "$stage")
case "$stage_name" in .codex-remote-write-????????-????-4???-????-????????????) ;; *) exit 47;; esac
if [ "$verb" = allocate ]; then
  payload=$4
  mkdir "$stage"
  chmod 700 "$stage"
  printf '%s' "$payload" | base64 -d > "$stage/request"
  [ "$(sha256sum "$stage/request" | awk '{print $1}')" = "$request_hash" ] || exit 47
  printf 'open\n' > "$stage/permit"
  sync -f "$stage/request"
  sync -f "$stage/permit"
  emit allocated open unknown
  exit 0
fi
if [ ! -e "$stage" ] && [ ! -L "$stage" ]; then
  if [ "$verb" = cleanup ] && [ "$#" -ge 4 ] && [ "$4" = closed ]; then emit cleaned closed unknown; else emit unknown unknown unknown; fi
  exit 0
fi
if [ ! -d "$stage" ] || [ -L "$stage" ]; then emit unknown unknown unknown; exit 0; fi
validate_stage() {
  plain_dir "$stage"
  [ "$(stat -c %u "$stage")" = "$(id -u)" ] && [ "$(stat -c %a "$stage")" = 700 ] || exit 47
  [ ! -L "$stage/request" ] && [ -f "$stage/request" ] && [ "$(stat -c %s "$stage/request")" -le 4096 ] || exit 47
  [ "$(sha256sum "$stage/request" | awk '{print $1}')" = "$request_hash" ] || exit 47
}
validate_stage
if ! mkdir "$stage/write.guard" 2>/dev/null; then emit unknown unknown unknown; exit 0; fi
validate_stage
line() { awk -v line="$1" 'NR==line { print; exit }' "$stage/request"; }
[ "$(line 1)" = v1 ] || exit 47
write_id=$(line 3)
[ "$stage_name" = ".codex-remote-write-$write_id" ] || exit 47
[ "$(awk 'END {print NR}' "$stage/request")" = 8 ] || exit 47
case "$(line 4)" in apply|restore|cleanup) ;; *) exit 47;; esac
target=$(line 5 | base64 -d)
expected=$(line 6)
after=$(line 7)
mode=$(line 8)
target_parent=$(dirname "$target")
plain_dir "$target_parent"
commit="$target_parent/.codex-remote-commit-$write_id"
current_hash() {
  [ ! -L "$target" ] || exit 47
  if [ ! -e "$target" ]; then printf missing; return; fi
  [ -f "$target" ] && [ "$(stat -c %s "$target")" -le 1048576 ] || exit 47
  sha256sum "$target" | awk '{print $1}'
}
[ ! -L "$stage/permit" ] && [ -f "$stage/permit" ] && [ "$(stat -c %s "$stage/permit")" -le 7 ] || exit 47
permit=$(cat "$stage/permit")
case "$permit" in open|closed) ;; *) exit 47;; esac
close_permit() {
  printf 'closed\n' > "$stage/permit.next"
  mv -T -- "$stage/permit.next" "$stage/permit"
  sync -f "$stage/permit"
}
finish() {
  printf '%s\n' "$1" > "$stage/result.next"
  mv -T -- "$stage/result.next" "$stage/result"
  sync -f "$stage/result"
  close_permit
  actual=$(current_hash)
  rmdir "$stage/write.guard"
  emit "$1" closed "$actual"
}
case "$verb" in
  write)
    if [ "$permit" != open ]; then rmdir "$stage/write.guard"; emit closed closed unknown; exit 0; fi
    if [ "$(current_hash)" != "$expected" ]; then finish conflict; exit 0; fi
    if [ "$after" = missing ]; then
      if [ "$expected" != missing ]; then rm -- "$target"; fi
    else
      [ ! -L "$stage/payload" ] && [ -f "$stage/payload" ] && [ "$(stat -c %s "$stage/payload")" -le 1048576 ] || exit 47
      [ "$(sha256sum "$stage/payload" | awk '{print $1}')" = "$after" ] || exit 47
      mkdir "$commit"
      cp -- "$stage/payload" "$commit/content"
      chmod "$mode" "$commit/content"
      sync -f "$commit/content"
      plain_dir "$target_parent"
      if [ "$(current_hash)" != "$expected" ]; then rm -- "$commit/content"; rmdir "$commit"; finish conflict; exit 0; fi
      if [ "$expected" = missing ]; then ln -- "$commit/content" "$target"; rm -- "$commit/content"
      else mv -T -- "$commit/content" "$target"; fi
      rmdir "$commit"
    fi
    [ "$(current_hash)" = "$after" ] || exit 48
    if [ "$after" != missing ]; then sync -f "$target"; fi
    finish applied
    ;;
  reconcile)
    close_permit
    actual=$(current_hash)
    rmdir "$stage/write.guard"
    emit reconciled closed "$actual"
    ;;
  cleanup)
    [ "$permit" = closed ] && [ ! -e "$commit" ] && [ ! -L "$commit" ] || exit 48
    for name in payload result request permit; do
      if [ -e "$stage/$name" ] || [ -L "$stage/$name" ]; then
        [ ! -L "$stage/$name" ] && [ -f "$stage/$name" ] || exit 47
        rm -- "$stage/$name"
      fi
    done
    rmdir "$stage/write.guard"
    if rmdir "$stage"; then emit cleaned closed unknown; else emit unknown closed unknown; fi
    ;;
  *) exit 47;;
esac
`;

export function protocolParameters(verb, plan) {
  if (!['allocate', 'write', 'reconcile', 'cleanup'].includes(verb)) fail('远端协议动作不受支持。');
  if (!plan || sha256(plan.request ?? '') !== plan.requestHash || plan.requestHash !== plan.stageRef?.requestHash) fail('远端协议请求已变化。');
  linuxPath(plan.stageRef.directory);
  if (!plan.stageRef.directory.endsWith(`/.codex-remote-write-${plan.writeId}`)) fail('远端暂存与写入身份不一致。');
  return [verb, plan.stageRef.directory, plan.requestHash, ...(verb === 'allocate' ? [Buffer.from(plan.request).toString('base64')] : []),
    ...(verb === 'cleanup' && plan.closedPermit === true ? ['closed'] : [])];
}

export function parseProtocolReceipt(text) {
  const match = text.replace(/\r\n/g, '\n').match(/^__CODEX_WRITE_V1__\nstatus=(allocated|applied|conflict|closed|reconciled|cleaned|unknown)\npermit=(open|closed|unknown)\nactual=(unknown|missing|[a-f0-9]{64})\n$/);
  if (!match) fail('远端写入回执不完整；原始输出未展示。');
  if (['applied', 'conflict', 'reconciled', 'cleaned', 'closed'].includes(match[1]) && match[2] !== 'closed'
      || match[1] === 'allocated' && match[2] !== 'open'
      || ['applied', 'conflict', 'reconciled'].includes(match[1]) && match[3] === 'unknown') fail('远端写入回执许可或摘要不一致。');
  return { status: match[1], permit: match[2], snapshot: match[3] === 'unknown' ? null : { exists: match[3] !== 'missing', sha256: match[3] === 'missing' ? null : match[3] } };
}

export async function runRemoteProtocol(options, verb, plan, { runSsh: execute = runSsh } = {}) {
  const parameters = protocolParameters(verb, plan);
  const receipt = parseProtocolReceipt(await execute(options, REMOTE_PROTOCOL_SCRIPT, parameters, 60_000, 'sh', `远端提交协议：${verb}`));
  const allowed = { allocate: ['allocated', 'unknown'], write: ['applied', 'conflict', 'closed', 'unknown'], reconcile: ['reconciled', 'unknown'], cleanup: ['cleaned', 'unknown'] };
  if (!allowed[verb].includes(receipt.status)) fail('远端回执与当前动作不一致。');
  return receipt;
}
