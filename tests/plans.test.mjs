import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { planConnection, planForwarding, planSettings, planResourceRestore, contentSnapshot } from '../scripts/config.mjs';
import { sshEffective, effectiveConnection, assertEffectiveForwardChange } from '../scripts/ssh.mjs';

const targetId = randomUUID(), cycleId = randomUUID();
const options = { filePath: 'C:\\test\\config', alias: 'codex-sample', hostname: 'example.test', username: 'root', sshPort: 22, targetId };
const restore = (plan, text = plan.text) => planResourceRestore({ kind: plan.kind, filePath: plan.path, text, firstRecovery: plan.firstRecovery });

test('全局前导、BOM/CRLF 和其他目标精确保留，转发移除后保留新连接', () => {
  for (const original of [null, '', '\uFEFFHost other\r\n  HostName old.test\r\n', '# keep\nServerAliveInterval 30\nHost *\n  Compression yes\n', 'ServerAliveInterval 30']) {
    const connection = planConnection({ ...options, sshText: original });
    const forward = planForwarding({ ...options, sshText: connection.text, localPort: 7897, remotePort: 17890, cycleId });
    assert.equal(forward.expectedBefore.sha256, connection.expectedAfter.sha256);
    assert.equal(restore(forward).text, connection.text);
    assert.match(restore(forward).text, /Host codex-sample/);
    assert.equal(restore(connection).text, original);
    if (original?.includes('ServerAliveInterval')) assert.ok(connection.text.indexOf('ServerAliveInterval') < connection.text.indexOf('Host codex-sample'));
    if (original?.startsWith('\uFEFF')) assert.equal(connection.text.charCodeAt(0), 0xfeff);
  }
});

test('等价用户连接和转发仅复用，移除不取得用户内容所有权', () => {
  const text = 'Host codex-sample\n  HostName example.test\n  RemoteForward 127.0.0.1:17890 127.0.0.1:7897\n';
  const connection = planConnection({ ...options, sshText: text, reuse: true });
  const forward = planForwarding({ ...options, sshText: text, localPort: 7897, remotePort: 17890, cycleId });
  assert.equal(connection.owned, false); assert.equal(forward.owned, false);
  assert.equal(restore(connection).text, text); assert.equal(restore(forward).text, text);
});

test('重复 alias、复杂布局、不完整标记和端口冲突均停止，不显示配置正文', () => {
  for (const text of ['Host codex-sample\nHost codex-sample\n', 'Host codex-sample other\n', 'Include file\nHost codex-sample\n', 'Host codex-sample\nMatch all\n', 'Host=codex-sample\n', '# BEGIN codex-remote-forward bad\nHost codex-sample\n', 'Host codex-sample\n  RemoteForward 17890 127.0.0.1:7897\n', 'Host codex-sample\n  RemoteForward 127.0.0.1:17890 127.0.0.1:9999\n']) {
    assert.throws(() => planForwarding({ ...options, sshText: text, localPort: 7897, remotePort: 17890, cycleId }));
  }
  assert.throws(() => planConnection({ ...options, sshText: 'Host codex-sample\n' }), /已占用/);
});

test('不同目标标记并存；重复当前周期不得被当成新所有权', () => {
  const connection = planConnection({ ...options, sshText: '' });
  const forward = planForwarding({ ...options, sshText: connection.text, localPort: 7897, remotePort: 17890, cycleId });
  assert.throws(() => planForwarding({ ...options, sshText: forward.text, localPort: 7897, remotePort: 17890, cycleId }), /写入意图/);
  const other = { ...options, targetId: randomUUID(), alias: 'codex-other' };
  const otherConnection = planConnection({ ...other, sshText: forward.text });
  const otherForward = planForwarding({ ...other, sshText: otherConnection.text, localPort: 7897, remotePort: 17891, cycleId: randomUUID() });
  assert.equal(restore(otherForward).text, otherConnection.text);
  assert.equal(restore(otherConnection).text, forward.text);
});

test('settings JSONC 最小插入与存在性可恢复，第三种状态保留用户修改', () => {
  for (const original of [null, '{}', '\uFEFF{\r\n  // keep\r\n  "editor.tabSize": 4\r\n}\r\n']) {
    const plan = planSettings({ settingsText: original, filePath: '/root/settings.json', remotePort: 17890 });
    assert.equal(restore(plan).text, original);
    assert.throws(() => restore(plan, plan.text + '\n'), /摘要/);
  }
  const connection = planConnection({ ...options, sshText: null });
  assert.deepEqual(connection.expectedBefore, { exists: false, sha256: null });
  assert.notDeepEqual(contentSnapshot(null), contentSnapshot(''));
  assert.throws(() => planSettings({ settingsText: '{"http.proxy":"http://user:TEST_SECRET@host:80"}', filePath: '/root/settings.json', remotePort: 17890 }), (error) => !error.message.includes('TEST_SECRET'));
  for (const settingsText of ['{"other":1,"other":2}', '{"other":{"duplicate":1,"duplicate":2}}']) {
    assert.throws(() => planSettings({ settingsText, filePath: '/root/settings.json', remotePort: 17890 }), /重复键/);
  }
});

test('Windows 系统 ssh -G 真实验证全局语义、连接身份及唯一转发差异', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-effective-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config');
  const original = 'ServerAliveInterval 30\nHost *\n  Compression yes\n';
  const connection = planConnection({ ...options, sshText: original, filePath: file });
  await fs.writeFile(file, connection.text);
  const before = await sshEffective({ host: options.alias, sshConfig: file });
  assert.deepEqual(effectiveConnection(before), { hostname: options.hostname, username: options.username, sshPort: options.sshPort });
  assert.match(before, /^serveraliveinterval 30$/m); assert.match(before, /^compression yes$/m);
  const forward = planForwarding({ ...options, sshText: connection.text, filePath: file, localPort: 7897, remotePort: 17890, cycleId });
  await fs.writeFile(file, forward.text);
  const after = await sshEffective({ host: options.alias, sshConfig: file });
  assertEffectiveForwardChange(before, after, 17890, 7897);
  await fs.writeFile(file, restore(forward).text);
  assert.equal(await sshEffective({ host: options.alias, sshConfig: file }), before);
});
