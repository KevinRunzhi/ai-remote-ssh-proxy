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
  verifyTarget,
} from '../scripts/ssh.mjs';

const PASSED_VERIFY_CHECKS = [
  { layer: 'local-proxy', status: 'pass', message: 'local ok' },
  { layer: 'ssh', status: 'pass', message: 'ssh ok' },
  { layer: 'remote-endpoint', status: 'pass', message: 'endpoint ok' },
  { layer: 'target-https', status: 'pass', message: 'https ok' },
];

const VERIFY_OPTIONS = {
  host: 'sample',
  sshConfig: 'C:\\sample config',
  remoteSettings: '/custom/vscode/settings.json',
};
const VERIFY_RECORD = {
  localProxy: 'http://127.0.0.1:7897',
  localPort: 7897,
  remotePort: 17890,
  listenerTool: 'proc',
};

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

test('verify 网络通过但找不到 app-server 时固定返回五层且证据不足', async () => {
  const result = await verifyTarget(VERIFY_OPTIONS, VERIFY_RECORD, {
    inspectTarget: async () => ({ ok: true, checks: PASSED_VERIFY_CHECKS }),
    runSsh: async () => '__CODEX_E2E__\nselection=none\n',
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.map(({ layer }) => layer), [
    'local-proxy', 'ssh', 'remote-endpoint', 'target-https', 'codex-process',
  ]);
  assert.deepEqual(result.checks.at(-1), {
    layer: 'codex-process',
    status: 'unknown',
    message: '未找到真实 Codex app-server 进程；请在远端窗口打开 Codex 后重试。',
  });
});

test('verify 发现非回环监听时停止，不继续 HTTPS 或进程探测', async () => {
  let httpsChecked = false;
  let processChecked = false;
  const result = await verifyTarget(VERIFY_OPTIONS, VERIFY_RECORD, {
    runProcess: async () => ({ exitCode: 0, stdout: 'http=401;connect=200;tls=0', stderr: '', timedOut: false }),
    sshEffective: async () => 'remoteforward 127.0.0.1:17890 127.0.0.1:7897\n',
    preflightRemote: async () => ({ version: 'test', listenerTool: 'proc' }),
    remoteRead: async () => ({ exists: true, hash: 'test', mode: '600', text: '{}' }),
    remoteListeners: async () => ['0.0.0.0:17890'],
    probeRemoteTarget: async () => { httpsChecked = true; },
    runSsh: async () => { processChecked = true; },
  });

  assert.equal(result.ok, false);
  assert.equal(httpsChecked, false);
  assert.equal(processChecked, false);
  assert.match(result.checks[2].message, /断开相关连接/);
  assert.equal(result.checks.at(-1).status, 'unknown');
});

test('verify 精确分类进程选择和代理环境证据', async () => {
  const cases = [
    [
      '__CODEX_E2E__\nselection=unverified\n',
      'unknown',
      /可执行文件或用户归属无法确认/,
    ],
    [
      '__CODEX_E2E__\nselection=ambiguous\ncount=2\n',
      'unknown',
      /找到 2 个.*--pid/,
    ],
    [
      '__CODEX_E2E__\nselection=missing\n',
      'unknown',
      /--pid 指定的进程不是当前 Codex app-server/,
    ],
    [
      '__CODEX_E2E__\npid=123\nidentity=match\nHTTP_PROXY=missing\nHTTPS_PROXY=match\nlowercase=ok\nbypass=ok\n',
      'unknown',
      /HTTP_PROXY=missing/,
    ],
    [
      '__CODEX_E2E__\npid=123\nidentity=match\nHTTP_PROXY=match\nHTTPS_PROXY=match\nlowercase=conflict\nbypass=ok\n',
      'fail',
      /lowercase=conflict/,
    ],
    [
      '__CODEX_E2E__\npid=123\nidentity=match\nHTTP_PROXY=match\nHTTPS_PROXY=match\nlowercase=ok\nbypass=conflict\n',
      'fail',
      /bypass=conflict/,
    ],
    [
      '__CODEX_E2E__\npid=123\nidentity=unverified\nHTTP_PROXY=match\nHTTPS_PROXY=match\nlowercase=ok\nbypass=ok\n',
      'unknown',
      /身份与归属证据不足/,
    ],
    [
      '__CODEX_E2E__\npid=123\nidentity=match\nHTTP_PROXY=match\nHTTPS_PROXY=match\nlowercase=ok\nbypass=ok\n',
      'pass',
      /PID 123/,
    ],
  ];

  for (const [stdout, status, message] of cases) {
    const calls = [];
    const result = await verifyTarget({ ...VERIFY_OPTIONS, pid: 123 }, VERIFY_RECORD, {
      inspectTarget: async (options) => {
        calls.push(['inspect', options]);
        return { ok: true, checks: PASSED_VERIFY_CHECKS };
      },
      runSsh: async (...args) => {
        calls.push(['ssh', args]);
        return stdout;
      },
    });
    assert.equal(result.checks.at(-1).status, status);
    assert.match(result.checks.at(-1).message, message);
    assert.equal(result.ok, status === 'pass');
    assert.equal(calls[0][1].remotePort, 17890);
    assert.equal(calls[0][1].remoteSettings, '/custom/vscode/settings.json');
    assert.deepEqual(calls[1][1][2].slice(0, 2), ['17890', '123']);
    assert.equal(calls[1][1][6][0], 46);
  }
});

test('verify 脱敏无法识别的进程输出', async () => {
  const secret = 'TEST_TOKEN_SHOULD_NOT_LEAK';
  const result = await verifyTarget(VERIFY_OPTIONS, VERIFY_RECORD, {
    inspectTarget: async () => ({ ok: true, checks: PASSED_VERIFY_CHECKS }),
    runSsh: async () => secret,
  });
  assert.equal(result.checks.at(-1).status, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});
