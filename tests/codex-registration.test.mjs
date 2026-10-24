import assert from 'node:assert/strict';
import test from 'node:test';
import { registeredCodex, preflightRemote, verifyTarget } from '../scripts/ssh.mjs';

const context = { home: '/root', architecture: 'x86_64' };
const name = 'openai.chatgpt-26.1021.22027-linux-x64';
const item = { identifier: { id: 'OpenAI.chatgpt' }, version: '26.1021.22027', relativeLocation: name,
  location: { scheme: 'file', path: `/root/.vscode-server/extensions/${name}` }, metadata: { targetPlatform: 'linux-x64' } };
const hash = 'a'.repeat(64);

test('只选有效注册包；不读取卸载残留目录，不按目录名选择最新版', async () => {
  assert.equal(registeredCodex(JSON.stringify([item]), context), name);
  assert.equal(registeredCodex('[]', context), null);
  assert.equal(registeredCodex(null, context), null);
  let calls = 0;
  const result = await preflightRemote({ codexHome: context.home, codexArchitecture: context.architecture, notify: () => {} }, {
    remoteRead: async (_, file) => { assert.equal(file, '/root/.vscode-server/extensions/extensions.json'); return { text: JSON.stringify([item]), hash }; },
    runSsh: async (_, script, args) => {
      calls++; assert.deepEqual(args, [name, hash]);
      assert.match(script, /registry_hash/);
      return `__CODEX_E2E__\nextension=${name}\nlistener_tool=proc\nstatic_chain=match\n`;
    },
  });
  assert.equal(calls, 1); assert.equal(result.version, name); assert.equal(result.registryHash, hash);
});

test('重复、平台错配、路径跳出、损坏注册表均拒绝且不展示正文', () => {
  for (const text of [JSON.stringify([item, item]), JSON.stringify([{ ...item, relativeLocation: '../TEST_SECRET' }]),
    JSON.stringify([{ ...item, metadata: { targetPlatform: 'linux-arm64' } }]),
    JSON.stringify([{ ...item, location: { scheme: 'file', path: '/other/TEST_SECRET' } }]),
    '{TEST_SECRET', '{}', '[null]']) {
    assert.throws(() => registeredCodex(text, context), (error) => !error.message.includes('TEST_SECRET'));
  }
});

test('没有注册包时返回未安装；注册摘要变化或回执选择其他包不能通过', async () => {
  const options = { codexHome: '/root', codexArchitecture: 'x86_64', notify: () => {} };
  const result = await preflightRemote(options, { remoteRead: async () => ({ text: '[]' }), runSsh: () => assert.fail() });
  assert.equal(result.registration, 'missing');
  for (const output of ['__CODEX_E2E__\nregistry=missing\n', '__CODEX_E2E__\nextension=other\nlistener_tool=proc\nstatic_chain=match\n']) {
    await assert.rejects(preflightRemote(options, { remoteRead: async () => ({ text: JSON.stringify([item]), hash }), runSsh: async () => output }));
  }
});

test('进程检查传入同一注册包和摘要；不接受路径注入或无摘要选择', async () => {
  const checks = ['local-proxy', 'ssh', 'remote-endpoint', 'target-https'].map(layer => ({ layer, status: 'pass' }));
  const result = await verifyTarget({ codexExtension: name, codexRegistryHash: hash }, { remotePort: 17890 }, {
    inspectTarget: async () => ({ checks }), runSsh: async (_, script, args) => {
      assert.deepEqual(args.slice(3), [name, hash]); assert.match(script, /sha256sum.*extensions\.json/);
      return '__CODEX_E2E__\nselection=unverified\n';
    },
  });
  assert.equal(result.ok, false);
  await assert.rejects(verifyTarget({ codexExtension: '../other', codexRegistryHash: hash }, {}));
  await assert.rejects(verifyTarget({ codexExtension: name }, {}));
});
