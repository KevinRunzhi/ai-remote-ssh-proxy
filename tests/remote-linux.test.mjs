import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { contentSnapshot } from '../scripts/config.mjs';
import { planRemoteWrite, protocolParameters, parseProtocolReceipt, REMOTE_PROTOCOL_SCRIPT } from '../scripts/remote-protocol.mjs';

// Windows 显式设置 CODEX_PROTOCOL_WSL=Ubuntu 才启动 WSL；只触及本次 /tmp 私有目录。
const enabled = process.platform === 'linux' || process.platform === 'win32' && process.env.CODEX_PROTOCOL_WSL === 'Ubuntu';
function shell(script, parameters = []) {
  const executable = process.platform === 'linux' ? '/bin/sh' : 'wsl.exe';
  const prefix = process.platform === 'linux' ? [] : ['-d', 'Ubuntu', '--exec', 'sh'];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...prefix, '-c', script, 'codex-trial', ...parameters], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', size = 0;
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', (chunk) => { size += chunk.length; if (size > 2 * 1024 * 1024) child.kill(); else stdout += chunk; });
    child.stderr.resume(); // 错误不转发正文。
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`Linux 试验退出 ${code}`)); });
  });
}
async function fixture(t, original = null, text = '{}\n') {
  const directory = (await shell('umask 077; mktemp -d /tmp/codex-protocol-XXXXXXXX')).trim();
  assert.match(directory, /^\/tmp\/codex-protocol-[a-zA-Z0-9]{8}$/);
  t.after(() => shell('case "$1" in /tmp/codex-protocol-????????) rm -rf -- "$1";; *) exit 47;; esac', [directory]));
  const targetPath = `${directory}/settings.json`;
  if (original !== null) await shell('printf %s "$2" | base64 -d > "$1"', [targetPath, Buffer.from(original).toString('base64')]);
  const plan = planRemoteWrite({ operationId: randomUUID(), writeId: randomUUID(), action: 'apply', stageParent: directory, targetPath,
    expectedBefore: contentSnapshot(original), expectedAfter: contentSnapshot(text) });
  const run = async (verb, script = REMOTE_PROTOCOL_SCRIPT) => parseProtocolReceipt(await shell(script, protocolParameters(verb, plan)));
  const payload = () => shell('printf %s "$2" | base64 -d > "$1/payload"; chmod 600 "$1/payload"', [plan.stageRef.directory, Buffer.from(text).toString('base64')]);
  return { directory, targetPath, plan, run, payload, read: () => shell('if [ -f "$1" ]; then cat -- "$1"; else printf missing; fi', [targetPath]) };
}

test('真实 Linux：提交、丢失回执后核对、清理及迟到写入不重建 stage', { skip: !enabled }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run('allocate')).status, 'allocated'); await f.payload();
  await f.run('write'); // 模拟调用方未保存此回执。
  const recovered = await f.run('reconcile');
  assert.equal(recovered.permit, 'closed'); assert.deepEqual(recovered.snapshot, f.plan && contentSnapshot('{}\n'));
  assert.equal(await f.read(), '{}\n');
  assert.equal((await f.run('cleanup')).status, 'cleaned');
  assert.equal((await f.run('write')).status, 'unknown');
  assert.equal(await shell('[ ! -e "$1" ]; printf absent', [f.plan.stageRef.directory]), 'absent');
});

test('真实 Linux：撤销许可后，延迟进入 guard 的旧写入不能提交', { skip: !enabled }, async (t) => {
  const f = await fixture(t, 'original'); await f.run('allocate'); await f.payload();
  const late = f.run('write', `sleep 1\n${REMOTE_PROTOCOL_SCRIPT}`);
  const recovered = await f.run('reconcile');
  assert.equal(recovered.permit, 'closed'); assert.deepEqual(recovered.snapshot, contentSnapshot('original'));
  assert.equal((await late).status, 'closed'); assert.equal(await f.read(), 'original');
  await f.run('cleanup');
});

test('真实 Linux：持 guard 或临界区异常退出时禁止核对与第二写入', { skip: !enabled }, async (t) => {
  const f = await fixture(t, 'original'); await f.run('allocate'); await f.payload();
  // 在取得 guard 后中断，协议无退出 trap；这也覆盖提交前进程消失。
  await assert.rejects(f.run('write', REMOTE_PROTOCOL_SCRIPT.replace('line() {', 'exit 99\nline() {')));
  for (const verb of ['write', 'reconcile', 'cleanup']) {
    const result = await f.run(verb); assert.equal(result.status, 'unknown'); assert.equal(result.permit, 'unknown');
  }
  assert.equal(await f.read(), 'original');
  assert.equal(await shell('[ -d "$1/write.guard" ]; printf retained', [f.plan.stageRef.directory]), 'retained');
});

test('真实 Linux：第三种文件状态、错误载荷、符号链接均不被覆盖', { skip: !enabled }, async (t) => {
  const changed = await fixture(t, 'original'); await changed.run('allocate'); await changed.payload();
  await shell('printf user-change > "$1"', [changed.targetPath]);
  assert.equal((await changed.run('write')).status, 'conflict'); assert.equal(await changed.read(), 'user-change');
  await changed.run('cleanup');
  const wrong = await fixture(t); await wrong.run('allocate');
  await shell('printf wrong > "$1/payload"', [wrong.plan.stageRef.directory]);
  await assert.rejects(wrong.run('write')); assert.equal(await wrong.read(), 'missing');
  const linked = await fixture(t); await linked.run('allocate'); await linked.payload();
  await shell('printf keep > "$2/other"; ln -s "$2/other" "$1"', [linked.targetPath, linked.directory]);
  await assert.rejects(linked.run('write'));
  assert.equal(await linked.read(), 'keep');
});

test('真实 Linux：恢复区分原不存在和已有空文件，原权限保留', { skip: !enabled }, async (t) => {
  for (const original of [null, '']) {
    const f = await fixture(t, original); await f.run('allocate'); await f.payload(); await f.run('write'); await f.run('cleanup');
    const restore = planRemoteWrite({ operationId: randomUUID(), writeId: randomUUID(), action: 'restore', stageParent: f.directory,
      targetPath: f.targetPath, expectedBefore: contentSnapshot('{}\n'), expectedAfter: contentSnapshot(original), mode: '640' });
    const run = async (verb) => parseProtocolReceipt(await shell(REMOTE_PROTOCOL_SCRIPT, protocolParameters(verb, restore)));
    await run('allocate');
    if (original !== null) await shell(': > "$1/payload"; chmod 600 "$1/payload"', [restore.stageRef.directory]);
    assert.equal((await run('write')).status, 'applied');
    assert.equal(await f.read(), original === null ? 'missing' : '');
    if (original !== null) assert.equal((await shell('stat -c %a "$1"', [f.targetPath])).trim(), '640');
    await run('cleanup');
  }
});
