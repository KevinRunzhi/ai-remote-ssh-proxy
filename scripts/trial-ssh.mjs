// 开发专用 S05 试验：不读取/修改真实配置、不共享业务状态，只在 mktemp 私有目录写合成样本。
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REMOTE_PROTOCOL_SCRIPT } from './remote-protocol.mjs';
import { normalizeConnection } from './input.mjs';
import { ExpectedError, runSsh } from './ssh.mjs';
import { preflightRemoteBase } from './preflight.mjs';

const protocol = Buffer.from(REMOTE_PROTOCOL_SCRIPT).toString('base64');
const TRIAL = String.raw`
set -eu
umask 077
trial=$(mktemp -d /tmp/codex-protocol-XXXXXXXX)
case "$trial" in /tmp/codex-protocol-????????) ;; *) exit 47;; esac
cleanup() { rm -rf -- "$trial"; }
trap cleanup EXIT
protocol=$(printf %s '$PROTOCOL' | base64 -d)
operation=00000000-0000-4000-8000-000000000001
write_id=00000000-0000-4000-8000-000000000002
stage="$trial/.codex-remote-write-$write_id"
target="$trial/settings.json"
printf 'synthetic-settings\n' > "$trial/payload"
after=$(sha256sum "$trial/payload" | awk '{print $1}')
make_request() {
  printf 'v1\n%s\n%s\napply\n%s\nmissing\n%s\n600\n' "$operation" "$write_id" "$(printf %s "$target" | base64 | tr -d '\n')" "$after" > "$trial/request"
  request_hash=$(sha256sum "$trial/request" | awk '{print $1}')
  request=$(base64 < "$trial/request" | tr -d '\n')
}
run() { sh -c "$protocol" -- "$1" "$stage" "$request_hash" "$request"; }
make_request
run allocate > /dev/null
[ "$(stat -c %a "$stage")" = 700 ]
cp "$trial/payload" "$stage/payload"
run write > "$trial/receipt"
grep -qx 'status=applied' "$trial/receipt"
run reconcile > "$trial/receipt"
grep -qx 'permit=closed' "$trial/receipt"
[ "$(sha256sum "$target" | awk '{print $1}')" = "$after" ]
run cleanup > /dev/null
run write > "$trial/receipt"
grep -qx 'status=unknown' "$trial/receipt"
[ ! -e "$stage" ]
rm "$target"

# 先核对关闭许可，再等待旧写入器；两个入口不能同时提交。
write_id=00000000-0000-4000-8000-000000000003
stage="$trial/.codex-remote-write-$write_id"
make_request; run allocate > /dev/null; cp "$trial/payload" "$stage/payload"
(sleep 1; run write > "$trial/late-receipt") & late=$!
run reconcile > "$trial/receipt"; wait "$late"
grep -qx 'permit=closed' "$trial/receipt"
grep -qx 'status=closed' "$trial/late-receipt"
[ ! -e "$target" ]; run cleanup > /dev/null

# 模拟异常退出遗留 guard：不得偷锁、恢复或进行第二次提交。
write_id=00000000-0000-4000-8000-000000000004
stage="$trial/.codex-remote-write-$write_id"
make_request; run allocate > /dev/null; cp "$trial/payload" "$stage/payload"
mkdir "$stage/write.guard"
run write > "$trial/receipt"; grep -qx 'permit=unknown' "$trial/receipt"
run reconcile > "$trial/receipt"; grep -qx 'permit=unknown' "$trial/receipt"
[ -d "$stage/write.guard" ] && [ ! -e "$target" ]
printf '__CODEX_TRIAL_V1__\nprivate-mode=pass\ncommit=pass\nlost-receipt=pass\nlate-writer=pass\nguard-busy=pass\ncleanup=pass\n'
`.replace('$PROTOCOL', protocol);

export async function runProtocolTrial(options) {
  const base = await preflightRemoteBase(options);
  const output = (await runSsh(options, TRIAL, [], 60_000, 'sh', '专用目录提交许可试验')).replace(/\r\n/g, '\n');
  const expected = '__CODEX_TRIAL_V1__\nprivate-mode=pass\ncommit=pass\nlost-receipt=pass\nlate-writer=pass\nguard-busy=pass\ncleanup=pass\n';
  if (output !== expected) throw new ExpectedError('受控远端试验没有返回完整通过证据；不展示原始输出。');
  return { version: 1, checkedAt: new Date().toISOString(), environment: { architecture: base.architecture, distribution: base.distribution, release: base.release, libc: base.libc },
    checks: ['private-mode', 'commit', 'lost-receipt', 'late-writer', 'guard-busy', 'cleanup'], status: 'pass',
    limitations: ['尚未验证 SCP/SFTP', '不代表真实 Server、settings 或 Codex 验收通过'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw new ExpectedError('请使用可见的原生交互终端。');
    const [hostname, username, sshPort] = process.argv.slice(2);
    const options = normalizeConnection({ inputMode: 'direct', hostname, username, sshPort });
    console.log('开发试验：仅在 /tmp 的本次私有目录写合成样本，结束后清理。可能分别提示两次认证。');
    const result = await runProtocolTrial(options);
    await fs.mkdir(new URL('../.cache/', import.meta.url), { recursive: true });
    await fs.writeFile(new URL('../.cache/remote-trial-result.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
    console.log('✅ 基础环境与提交许可试验通过。尚未配置真实文件。');
  } catch (error) { console.error(error instanceof ExpectedError ? error.message : '试验未完成；原始错误未展示。'); process.exitCode = 1; }
}
