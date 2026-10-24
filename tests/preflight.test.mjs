import assert from 'node:assert/strict';
import test from 'node:test';
import { preflightRemoteBase } from '../scripts/preflight.mjs';

const clean = '__CODEX_BASIC_V1__\narchitecture=x86_64\nuid=0\nhome=L3Jvb3Q=\ndistribution=ubuntu\nrelease=22.04\nlibc=glibc 2.35\nlistener=proc\n';
test('干净容器基础预检不依赖 Server/Codex，保留 signal 和通知', async () => {
  const signal = new AbortController().signal;
  const notify = () => {};
  const result = await preflightRemoteBase({ signal, notify }, { runSsh: async (options, script) => {
    assert.equal(options.signal, signal); assert.equal(options.notify, notify);
    assert.doesNotMatch(script, /vscode-server|openai\.chatgpt|settings\.json/);
    return clean;
  } });
  assert.equal(result.home, '/root'); assert.equal(result.libc, '2.35');
  assert.equal(result.transfer, 'unverified'); assert.equal(result.forwarding, 'unverified');
});
test('缺少工具、异常输出、非法 home 均停止，原始输出不会泄漏', async () => {
  for (const text of ['__CODEX_BASIC_V1__\nmissing=curl\n', `${clean}TEST_SECRET`, clean.replace('L3Jvb3Q=', 'L3Jvb3QK'), clean.replace('glibc 2.35', 'unknown')]) {
    await assert.rejects(preflightRemoteBase({}, { runSsh: async () => text }), (error) => !error.message.includes('TEST_SECRET'));
  }
});
