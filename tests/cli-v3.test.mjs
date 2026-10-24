import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { projectQuestion } from '../app/projection.mjs';
import { parseArgs, runCli } from '../scripts/e2e.mjs';
import { acquireInstance, createStateStore } from '../scripts/state.mjs';

test('新版 CLI 保留合法旧参数，命令注入、重复及目标替换参数均拒绝', () => {
  const parsed = parseArgs(['configure', '--host', 'sample', '--local-proxy', 'http://localhost:7897/', '--remote-port', '17890', '--remote-settings', '/root/settings.json']);
  assert.equal(parsed.host, 'sample'); assert.equal(parsed.remoteSettings, '/root/settings.json');
  assert.equal(parseArgs(['verify', '--pid', '1234567']).pid, 1234567);
  for (const args of [['configure', '--yes', 'true'], ['remove', '--remote-port', '17890'], ['configure', '--ssh-config', 'relative'],
    ['configure', '--host', 'sample', '--ssh-command', 'ssh root@host'], ['configure', '--ssh-command', 'ssh root@host;bad'], ['verify', '--pid', '1.2']]) assert.throws(() => parseArgs(args));
});

test('CLI 与网页共用执行器，等待期间持实例锁，结束释放；不经旧版提交逻辑', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cli-test-')), directory = path.join(root, 'state');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const deps = { restrictDirectory: async () => {} };
  let called = 0; const output = [];
  const code = await runCli({ options: parseArgs(['configure', '--ssh-command', 'ssh -p 22 root@sample.test', '--local-proxy', 'http://127.0.0.1:7897']),
    io: { isInteractive: true, choose: async () => 'confirm', prompt: async () => assert.fail('不应额外询问'), write: (text) => output.push(text) },
    dependencies: { stateDirectory: directory, acquireInstance: (dir) => acquireInstance(dir, deps), runOperation: async (input, io, dependencies) => {
      called++; assert.equal(input.kind, 'initialize'); assert.equal(input.connection.hostname, 'sample.test');
      await assert.rejects(acquireInstance(directory, deps), /已有工作实例/);
      assert.equal(typeof io.waitForUser, 'function'); assert.ok(dependencies.store);
      return { outcome: 'needs-user', stage: 'server', checks: [], nextAction: 'prepare-server', fullConfig: 'TEST_SECRET' };
    } } });
  assert.equal(code, 0); assert.equal(called, 1); assert.ok(!output.join('').includes('TEST_SECRET'));
  const next = await acquireInstance(directory, deps); await next.release();
});

test('已有目标 configure 明确选择原容器后映射 resume；矛盾参数不调用工作流', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cli-test-')), directory = path.join(root, 'state');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockDeps = { restrictDirectory: async () => {} }, instance = await acquireInstance(directory, lockDeps), store = createStateStore(directory, instance);
  await store.initializeEntry(); const target = await store.createTarget({ expectedEntryRevision: 0, confirmedPreviewRevision: 1,
    connection: { alias: 'sample', hostname: 'sample.test', username: 'root', sshPort: 22, sshConfig: path.join(root, 'config') } });
  await instance.release(); let called = 0;
  const execute = (args) => runCli({ options: parseArgs(args), io: { isInteractive: true, choose: async () => 'confirm', write: () => {} },
    dependencies: { stateDirectory: directory, acquireInstance: (dir) => acquireInstance(dir, lockDeps), runOperation: async (input) => {
      called++; assert.equal(input.kind, 'resume'); assert.equal(input.targetId, target.targetId); assert.equal(input.declaration, 'original-container');
      return { outcome: 'needs-user', stage: 'server', checks: [], nextAction: 'prepare-server' };
    } } });
  assert.equal(await execute(['configure', '--host', 'sample']), 0);
  assert.equal(await execute(['configure', '--host', 'other']), 1); assert.equal(called, 1);
});

test('CLI 遗留锁确认通过同一问题投影，然后才允许业务选择', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cli-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'instance.lock'), JSON.stringify({ version: 1, ownerId: randomUUID(), pid: 2147483000, processStartedAt: new Date().toISOString() }));
  const questions = [];
  const code = await runCli({ options: parseArgs(['configure', '--ssh-command', 'ssh root@sample.test', '--local-proxy', 'http://127.0.0.1:7897']),
    io: { isInteractive: true, write: () => {}, choose: async (question) => { questions.push(projectQuestion(question)); return 'confirm'; } },
    dependencies: { stateDirectory: directory, restrictDirectory: async () => {},
      acquireRecoveryGuard: async () => ({ assertOwned() {}, async release() {} }), inspectRecoveryProcesses: async () => ({ owners: [], transports: [] }),
      runOperation: async () => ({ outcome: 'needs-user', stage: 'server', checks: [], nextAction: 'prepare-server' }) } });
  assert.equal(code, 0); assert.equal(questions.length, 2); assert.match(questions[0].title, /遗留锁/);
  assert.equal(await fs.stat(path.join(directory, 'instance.lock')).catch(() => null), null);
});
