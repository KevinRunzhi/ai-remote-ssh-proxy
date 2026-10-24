import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sha256 } from '../scripts/config.mjs';
import { planRemoteWrite, protocolParameters, parseProtocolReceipt, runRemoteProtocol } from '../scripts/remote-protocol.mjs';

const input = () => ({ operationId: randomUUID(), writeId: randomUUID(), action: 'apply', stageParent: '/root', targetPath: '/root/Machine/settings.json',
  expectedBefore: { exists: false, sha256: null }, expectedAfter: { exists: true, sha256: sha256('{}\n') } });
test('远端计划先给出 stage/commit 定位；请求不含配置正文；每次写入身份独立', () => {
  const values = input(), first = planRemoteWrite(values), second = planRemoteWrite(input());
  assert.notEqual(first.stageRef.directory, second.stageRef.directory);
  assert.equal(first.requestHash, sha256(first.request));
  assert.ok(first.stageRef.directory.endsWith(values.writeId));
  assert.ok(first.stageRef.commitDirectory.endsWith(values.writeId));
  assert.ok(!first.request.includes('{}'));
  assert.deepEqual(protocolParameters('allocate', first).slice(0, 3), ['allocate', first.stageRef.directory, first.requestHash]);
  const changed = structuredClone(first); changed.request += 'extra';
  assert.throws(() => protocolParameters('write', changed), /已变化/);
});
test('远端请求拒绝非法身份、路径、摘要和权限', () => {
  const base = input();
  for (const changes of [{ operationId: [base.operationId] }, { writeId: '../file' }, { targetPath: '/root/../settings' }, { targetPath: '/root/settings\n' },
    { stageParent: '/' }, { mode: '4755' }, { action: 'apply', expectedAfter: { exists: false, sha256: null } }, { expectedBefore: { exists: true, sha256: ['a'.repeat(64)] } }]) {
    assert.throws(() => planRemoteWrite({ ...base, ...changes }));
  }
});
test('guard 忙、缺失与实际摘要分开报告；完整回执不能伪造 permit 已关闭', () => {
  const receipt = (status, permit, actual) => `__CODEX_WRITE_V1__\nstatus=${status}\npermit=${permit}\nactual=${actual}\n`;
  assert.deepEqual(parseProtocolReceipt(receipt('unknown', 'unknown', 'unknown')), { status: 'unknown', permit: 'unknown', snapshot: null });
  assert.deepEqual(parseProtocolReceipt(receipt('reconciled', 'closed', 'missing')).snapshot, { exists: false, sha256: null });
  for (const text of [receipt('applied', 'open', 'a'.repeat(64)), receipt('applied', 'closed', 'unknown'), receipt('reconciled', 'unknown', 'missing'), 'TEST_SECRET']) {
    assert.throws(() => parseProtocolReceipt(text), (error) => !error.message.includes('TEST_SECRET'));
  }
});
test('协议传输保持当前 signal/notify；未知状态不会当成可恢复证据', async () => {
  const signal = new AbortController().signal, notify = () => {};
  const result = await runRemoteProtocol({ signal, notify }, 'reconcile', planRemoteWrite(input()), { runSsh: async (options, script, parameters) => {
    assert.equal(options.signal, signal); assert.equal(options.notify, notify);
    assert.equal(parameters[0], 'reconcile');
    assert.ok(!script.includes('trap '));
    return '__CODEX_WRITE_V1__\nstatus=unknown\npermit=unknown\nactual=unknown\n';
  } });
  assert.equal(result.snapshot, null); assert.equal(result.permit, 'unknown');
});
