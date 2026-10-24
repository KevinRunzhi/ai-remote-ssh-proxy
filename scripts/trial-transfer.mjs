// 开发专用：只验证本次 /tmp 合成载荷的 SCP/SFTP，不改真实配置。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeConnection } from './input.mjs';
import { runSsh, runScp, ExpectedError } from './ssh.mjs';
import { sha256 } from './config.mjs';
try {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new ExpectedError('需要原生交互终端。');
  const [hostname, username, sshPort] = process.argv.slice(2), options = normalizeConnection({ inputMode: 'direct', hostname, username, sshPort });
  const id = randomUUID(), remote = `/tmp/codex-transfer-${id}`, local = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transfer-'));
  const payload = `synthetic-transfer-${id}\n`, digest = sha256(payload);
  let allocated = false;
  console.log('仅上传私有合成文件，可能需要三次原生认证；不读取或修改真实配置。');
  try {
    await fs.writeFile(path.join(local, 'payload'), payload, { flag: 'wx', mode: 0o600 });
    const created = await runSsh(options, 'set -eu; umask 077; mkdir -- "$1"; printf "allocated\\n"', [remote]);
    if (created !== 'allocated\n') throw new ExpectedError('试验目录分配未确认。');
    allocated = true;
    await runScp(options, path.join(local, 'payload'), `${remote}/payload`, '专用合成文件 SCP/SFTP 验证');
    const result = await runSsh(options, String.raw`set -eu
folder=$1
[ -d "$folder" ] && [ ! -L "$folder" ] && [ "$(stat -c %u "$folder")" = "$(id -u)" ] && [ "$(stat -c %a "$folder")" = 700 ]
[ -f "$folder/payload" ] && [ ! -L "$folder/payload" ]
[ "$(sha256sum "$folder/payload" | awk '{print $1}')" = "$2" ]
[ "$(find "$folder" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ]
rm -- "$folder/payload"; rmdir -- "$folder"
printf 'transfer-cleaned\n'`, [remote, digest]);
    if (result !== 'transfer-cleaned\n') throw new ExpectedError('传输/清理回执不完整。');
    allocated = false;
    await fs.mkdir(new URL('../.cache/', import.meta.url), { recursive: true });
    await fs.writeFile(new URL('../.cache/transfer-trial-result.json', import.meta.url), JSON.stringify({ version: 1, checkedAt: new Date().toISOString(),
      status: 'pass', checks: ['native-auth', 'scp-sftp-upload', 'remote-sha256', 'private-directory', 'cleanup'], limitations: ['未验证正式 settings 和 VS Code/Codex'] }, null, 2));
    console.log('✅ 传输、远端摘要与清理通过。');
  } finally {
    await fs.rm(local, { recursive: true, force: true });
    if (allocated) console.log(`试验目录可能残留：${remote}。未自动重试或删除未知文件。`);
  }
} catch (error) { console.error(error instanceof ExpectedError ? error.message : '传输试验未完成；原始错误未展示。'); process.exitCode = 1; }
