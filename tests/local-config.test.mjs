import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { acquireInstance } from '../scripts/state.mjs';
import { readLocalConfig, writeLocalPlan } from '../scripts/local-config.mjs';
import { planConnection, planForwarding, planResourceRestore } from '../scripts/config.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-local-test-'));
  const instance = await acquireInstance(path.join(directory, 'state'), { restrictDirectory: async () => {} });
  t.after(async () => { await instance.release(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, instance, file: path.join(directory, 'config') };
}
function connection(file, text) { return planConnection({ sshText: text, filePath: file, alias: 'sample', hostname: 'example.test', username: 'root', targetId: randomUUID() }); }
function restore(plan) { return planResourceRestore({ kind: plan.kind, filePath: plan.path, text: plan.text, firstRecovery: plan.firstRecovery }); }
function writePlan(plan, lease, options = {}) {
  return writeLocalPlan(plan, lease, { stageDirectory: path.join(path.dirname(plan.path), `.codex-write-${randomUUID()}`), ...options });
}

test('真实临时文件闭环区分不存在与空文件；移除转发保留连接', async (t) => {
  const { directory, file, instance } = await fixture(t);
  for (const original of [null, '', '\uFEFF# keep\r\nHost other\r\n  HostName other.test\r\n']) {
    if (original === null) await fs.rm(file, { force: true }); else await fs.writeFile(file, original);
    assert.equal((await readLocalConfig(file)).text, original);
    const plan = connection(file, original);
    await instance.withWriteLock((lease) => writePlan(plan, lease));
    const forwarding = planForwarding({ sshText: plan.text, filePath: file, alias: 'sample', localPort: 7897, remotePort: 17890,
      targetId: randomUUID(), cycleId: randomUUID() });
    await instance.withWriteLock((lease) => writePlan(forwarding, lease));
    await instance.withWriteLock((lease) => writePlan(restore(forwarding), lease));
    assert.equal((await readLocalConfig(file)).text, plan.text);
    await instance.withWriteLock((lease) => writePlan(restore(plan), lease));
    assert.equal((await readLocalConfig(file)).text, original);
  }
  assert.deepEqual((await fs.readdir(directory)).sort(), ['config', 'state']);
});

test('确认后和暂存后用户改动都不被覆盖，缺锁不写；临时资源清理', async (t) => {
  const { directory, file, instance } = await fixture(t);
  const plan = connection(file, null);
  await assert.rejects(writeLocalPlan(plan), /写入锁/);
  await fs.writeFile(file, 'user-content');
  await assert.rejects(instance.withWriteLock((lease) => writePlan(plan, lease)), /已变化/);
  await fs.rm(file);
  await assert.rejects(instance.withWriteLock((lease) => writePlan(plan, lease, { beforePublish: () => fs.writeFile(file, 'late-user-content') })), /已变化/);
  assert.equal(await fs.readFile(file, 'utf8'), 'late-user-content');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['config', 'state']);
});

test('本机读取拒绝链接、非法 UTF-8、UTF-16 和超限，原字节不变', async (t) => {
  const { directory, file } = await fixture(t);
  for (const bytes of [Buffer.from([0xff, 0xfe, 0x7b, 0]), Buffer.from([0xff]), Buffer.alloc(1024 * 1024 + 1, 0x61)]) {
    await fs.writeFile(file, bytes); await assert.rejects(readLocalConfig(file));
    assert.deepEqual(await fs.readFile(file), bytes);
  }
  const real = path.join(directory, 'actual'); await fs.mkdir(real);
  const linked = path.join(directory, 'linked'); await fs.symlink(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readLocalConfig(path.join(linked, 'config')), /链接/);
});

test('暂存目录碰撞不取得清理权，已有目录及内容保留', async (t) => {
  const { directory, file, instance } = await fixture(t);
  const stageDirectory = path.join(directory, `.codex-write-${randomUUID()}`);
  await fs.mkdir(stageDirectory);
  await fs.writeFile(path.join(stageDirectory, 'owned-by-other'), 'keep');
  await assert.rejects(instance.withWriteLock((lease) => writePlan(connection(file, null), lease, { stageDirectory })), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(stageDirectory, 'owned-by-other'), 'utf8'), 'keep');
  assert.equal((await readLocalConfig(file)).text, null);
});

test('全新 .ssh/config 预览不建目录；确认后受限创建，不递归创建任意父目录', async (t) => {
  const { directory, instance } = await fixture(t);
  const file = path.join(directory, '.ssh', 'config');
  assert.equal((await readLocalConfig(file)).text, null);
  assert.equal(await fs.stat(path.dirname(file)).catch(() => null), null);
  const plan = connection(file, null);
  await instance.withWriteLock((lease) => writePlan(plan, lease));
  assert.equal((await readLocalConfig(file)).text, plan.text);
  await instance.withWriteLock((lease) => writePlan(restore(plan), lease));
  assert.equal((await readLocalConfig(file)).text, null);
  assert.deepEqual(await fs.readdir(path.dirname(file)), []);
  await assert.rejects(readLocalConfig(path.join(directory, 'other', 'config')), { code: 'ENOENT' });
});
