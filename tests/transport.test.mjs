import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CancelledError,
  ExpectedError,
  checkConfiguredEndpoint,
  classifyCurlResult,
  classifyEndpoint,
  hasExpectedRemoteForward,
  inspectTarget,
  remoteCommand,
  runProcess,
  sshBaseArgs,
} from '../scripts/ssh.mjs';

test('runProcess 使用参数数组且不经过 shell', async () => {
  const value = 'a b;$(ignored)&echo nope';
  const result = await runProcess({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write(process.argv[1])', value],
    timeoutMs: 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, value);
  assert.equal(result.stderr, '');
  assert.equal(result.timedOut, false);
});

test('runProcess 超时后结束子进程', async () => {
  const result = await runProcess({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)'],
    timeoutMs: 250,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout, /^\d+$/);
  assert.throws(() => process.kill(Number(result.stdout), 0));
});

test('runProcess 收到 Ctrl+C 后结束子进程', async () => {
  const running = runProcess({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)'],
    timeoutMs: 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  setTimeout(() => process.emit('SIGINT'), 50);

  await assert.rejects(running, (error) => (
    error instanceof ExpectedError && error.message === '操作已取消。'
  ));
});

test('取消本地检查会立即结束 inspect，不再启动 SSH', async () => {
  const cancelled = new CancelledError('操作已取消。');
  let sshStarted = false;

  await assert.rejects(
    inspectTarget({
      host: 'sample',
      sshConfig: 'C:\\sample config',
      localProxy: 'http://127.0.0.1:7897',
      localPort: 7897,
      remotePort: 17890,
    }, {
      runProcess: async () => { throw cancelled; },
      sshEffective: async () => {
        sshStarted = true;
        throw new Error('SSH 不应启动');
      },
    }),
    (error) => error === cancelled,
  );
  assert.equal(sshStarted, false);
});

test('curl CONNECT 200、TLS 0、目标 401 判定通过', () => {
  assert.deepEqual(
    classifyCurlResult({
      exitCode: 0,
      stdout: 'http=401;connect=200;tls=0',
      stderr: '',
      timedOut: false,
    }),
    {
      ok: true,
      kind: 'reachable',
      message: 'CONNECT 200、TLS 有效、目标返回预期 401。',
      evidence: { exitCode: 0, httpStatus: 401, connectStatus: 200, tlsResult: 0 },
    },
  );
});

test('curl 代理、TLS、超时和连接失败均安全分类', () => {
  const secret = 'TEST_TOKEN_SHOULD_NOT_LEAK';
  const cases = [
    [{ exitCode: 0, stdout: 'http=000;connect=407;tls=0', stderr: secret, timedOut: false }, 'proxy-authentication'],
    [{ exitCode: 60, stdout: 'http=000;connect=200;tls=1', stderr: secret, timedOut: false }, 'tls'],
    [{ exitCode: null, stdout: '', stderr: secret, timedOut: true }, 'timeout'],
    [{ exitCode: 7, stdout: '', stderr: secret, timedOut: false }, 'transport'],
  ];

  for (const [input, kind] of cases) {
    const result = classifyCurlResult(input);
    assert.equal(result.ok, false);
    assert.equal(result.kind, kind);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  }
});

test('SSH 参数关闭转发与复用且不创建反向转发', () => {
  const args = sshBaseArgs({ sshConfig: 'C:\\sample config' });
  assert.deepEqual(args, [
    '-F', 'C:\\sample config',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
  ]);
  assert.equal(args.includes('-R'), false);
});

test('远端脚本和参数编码后不暴露特殊字符', () => {
  const command = remoteCommand('printf "%s\\n" "$1"', ['a b;$(ignored)']);
  assert.doesNotMatch(command, /a b|ignored/);
  assert.match(command, /base64 -d/);
});

test('识别有效的等价 RemoteForward', () => {
  assert.equal(hasExpectedRemoteForward(
    'hostname example.invalid\nremoteforward 127.0.0.1:17890 127.0.0.1:7897\n',
    17890,
    7897,
  ), true);
  assert.equal(hasExpectedRemoteForward(
    'remoteforward 127.0.0.1:17891 127.0.0.1:7897\n',
    17890,
    7897,
  ), false);
  assert.equal(hasExpectedRemoteForward(
    'remoteforward [127.0.0.1]:17890 [127.0.0.1]:7897\n',
    17890,
    7897,
  ), true);
});

test('远端端口状态区分空闲、正常、待重连和未知占用', () => {
  assert.deepEqual(classifyEndpoint({ listeners: [], hasExpectedForward: false, remotePort: 17890 }), {
    status: 'pass', message: '候选远端端口 17890 空闲。', shouldProbeTarget: false,
  });
  assert.deepEqual(classifyEndpoint({ listeners: ['127.0.0.1:17890'], hasExpectedForward: true, remotePort: 17890 }), {
    status: 'pass', message: '预期 IPv4 回环入口正在监听。', shouldProbeTarget: true,
  });
  assert.deepEqual(classifyEndpoint({ listeners: [], hasExpectedForward: true, remotePort: 17890 }), {
    status: 'unknown', message: '配置包含预期转发，但远端入口尚未监听；需要重连。', shouldProbeTarget: false,
  });
  assert.deepEqual(classifyEndpoint({ listeners: ['127.0.0.1:17890'], hasExpectedForward: false, remotePort: 17890 }), {
    status: 'fail', message: '远端端口已被来源不明的监听占用。', shouldProbeTarget: false,
  });
});

test('重复配置不会把失效代理端点误报为正常', async () => {
  await assert.rejects(
    checkConfiguredEndpoint({ host: 'sample' }, 'proc', 17890, {
      remoteListeners: async () => ['127.0.0.1:17890'],
      probeRemoteTarget: async () => ({ ok: false, message: '代理连接或网络传输失败。' }),
    }),
    (error) => error instanceof ExpectedError && error.message.includes('代理连接或网络传输失败'),
  );
});
