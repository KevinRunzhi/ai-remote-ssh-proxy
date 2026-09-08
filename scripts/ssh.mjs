import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';

const SSH_READY_MARKER = '__CODEX_E2E_SSH_READY__';
const RESULT_MARKER = '__CODEX_E2E__\n';
const DEFAULT_TARGET_URL = 'https://api.openai.com/v1/models';
const DEFAULT_REMOTE_SETTINGS = '~/.vscode-server/data/Machine/settings.json';

export class ExpectedError extends Error {}
export class CancelledError extends ExpectedError {}

function fail(message) {
  throw new ExpectedError(message);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function runProcess({
  executable,
  args,
  timeoutMs = 20_000,
  stdio = ['pipe', 'pipe', 'pipe'],
}) {
  if (typeof executable !== 'string' || !Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    return Promise.reject(new TypeError('外部进程必须使用可执行文件和字符串参数数组。'));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let interrupted = false;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      process.removeListener('SIGINT', onSigint);
    };
    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    const onSigint = () => {
      interrupted = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    process.once('SIGINT', onSigint);
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    if (child.stdin) child.stdin.end();
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (interrupted) {
        reject(new CancelledError('操作已取消。'));
        return;
      }
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}

export function openSshExecutables() {
  if (process.platform !== 'win32' || !process.env.WINDIR) fail('首版仅支持 Windows 系统 OpenSSH。');
  const directory = path.join(process.env.WINDIR, 'System32', 'OpenSSH');
  return { ssh: path.join(directory, 'ssh.exe'), scp: path.join(directory, 'scp.exe') };
}

export function sshBaseArgs(options) {
  return [
    '-F', options.sshConfig,
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
  ];
}

export function runInteractiveProcess(executable, args, {
  stdoutMode = 'pipe', authenticationTimeoutMs = 120_000, operationTimeoutMs = 60_000,
  readyMarker = SSH_READY_MARKER, stepLabel = '执行远端操作', cancelProbe = false,
} = {}) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) fail('当前不是交互式终端；请在 PowerShell 中运行。');
  console.log(`⏳ ${stepLabel}：OpenSSH 可能要求密码；请在原生提示后输入，内容不回显也不会被 Node 读取。`);
  if (cancelProbe) console.log('请在密码提示出现时按 Ctrl+C，不要输入密码。');

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['inherit', stdoutMode, 'inherit'],
    });
    let stdout = '';
    let authenticated = false;
    let timedOut = false;
    let cancelled = false;
    let timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, authenticationTimeoutMs);

    const onSigint = () => {
      cancelled = true;
      child.kill();
    };
    process.once('SIGINT', onSigint);
    if (stdoutMode === 'pipe') {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (!authenticated && new RegExp(`${escapeRegExp(readyMarker)}\\r?\\n`).test(stdout)) {
          authenticated = true;
          clearTimeout(timer);
          timer = setTimeout(() => {
            timedOut = true;
            child.kill();
          }, operationTimeoutMs);
          console.log(`✅ 认证成功，开始执行：${stepLabel}`);
        }
      });
    }
    child.on('error', (error) => {
      clearTimeout(timer);
      process.removeListener('SIGINT', onSigint);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      process.removeListener('SIGINT', onSigint);
      resolve({
        exitCode,
        signal,
        stdout: stdout.replace(new RegExp(`${escapeRegExp(readyMarker)}\\r?\\n`), ''),
        timedOut,
        authenticated,
        cancelled,
      });
    });
  });
}

export function remoteCommand(script, parameters = [], shell = 'sh') {
  if (!['sh', 'bash'].includes(shell)) fail('远端 Shell 不受支持。');
  const encodedScript = Buffer.from(script).toString('base64');
  const encodedParameters = parameters.map((value) => {
    if (typeof value !== 'string' || value.includes('\0')) fail('远端参数不合法。');
    return Buffer.from(value).toString('base64');
  });
  const decodedParameters = encodedParameters.map((value) => `"$(printf '%s' '${value}' | base64 -d)"`).join(' ');
  return `printf '${SSH_READY_MARKER}\\n'; ${shell} -c "$(printf '%s' '${encodedScript}' | base64 -d)" -- ${decodedParameters}`;
}

export async function runSsh(
  options,
  script,
  parameters = [],
  operationTimeoutMs = 60_000,
  shell = 'sh',
  stepLabel = '执行远端操作',
  acceptedExitCodes = [],
) {
  const { ssh } = openSshExecutables();
  const args = ['-T', ...sshBaseArgs(options), options.host, remoteCommand(script, parameters, shell)];
  const result = await runInteractiveProcess(ssh, args, { operationTimeoutMs, stepLabel });
  if (result.timedOut) fail(`${stepLabel}超时；${result.authenticated ? 'SSH 已认证，但远端操作未完成' : 'SSH 认证未完成'}。`);
  if (result.cancelled) throw new CancelledError(`${stepLabel}已取消；未继续执行。`);
  if (result.exitCode !== 0 && !acceptedExitCodes.includes(result.exitCode)) {
    fail(`${stepLabel}失败（退出码 ${result.exitCode ?? '未知'}；${result.authenticated ? 'SSH 已认证' : 'SSH 认证未完成'}）；原始输出未展示。`);
  }
  if (result.exitCode === 0) console.log(`✅ 已完成：${stepLabel}`);
  return result.stdout;
}

export async function runScp(options, localFile, remoteFile, stepLabel) {
  const { scp } = openSshExecutables();
  const result = await runInteractiveProcess(scp, [
    ...sshBaseArgs(options), '--', localFile, `${options.host}:${remoteFile}`,
  ], { readyMarker: '__SCP_HAS_NO_READY_MARKER__', stepLabel });
  if (result.timedOut) fail(`${stepLabel}超时。`);
  if (result.cancelled) throw new CancelledError(`${stepLabel}已取消。`);
  if (result.exitCode !== 0) fail(`${stepLabel}失败（退出码 ${result.exitCode ?? '未知'}）。`);
  console.log(`✅ 已完成：${stepLabel}`);
}

export function classifyCurlResult(result) {
  const match = result.stdout.match(/http=(\d+);connect=(\d+);tls=(\d+)/);
  const evidence = {
    exitCode: result.exitCode,
    httpStatus: match ? Number(match[1]) : null,
    connectStatus: match ? Number(match[2]) : null,
    tlsResult: match ? Number(match[3]) : null,
  };
  if (result.timedOut) return { ok: false, kind: 'timeout', message: '网络检查超时。', evidence };
  if (evidence.connectStatus === 407) return { ok: false, kind: 'proxy-authentication', message: '代理返回 407，首版不支持认证代理。', evidence };
  if (result.exitCode === 60 || (evidence.tlsResult !== null && evidence.tlsResult !== 0)) {
    return { ok: false, kind: 'tls', message: '目标 TLS 校验失败。', evidence };
  }
  if (result.exitCode !== 0 || !match) return { ok: false, kind: 'transport', message: '代理连接或网络传输失败。', evidence };
  if (evidence.connectStatus !== 200) return { ok: false, kind: 'proxy', message: `代理 CONNECT 返回 ${evidence.connectStatus}。`, evidence };
  if (evidence.httpStatus !== 401) return { ok: false, kind: 'target-status', message: `目标返回非预期 HTTP ${evidence.httpStatus}。`, evidence };
  return { ok: true, kind: 'reachable', message: 'CONNECT 200、TLS 有效、目标返回预期 401。', evidence };
}

function curlArgs(proxy, output, targetUrl) {
  return [
    '-q', '--proxy', proxy, '--noproxy', '',
    '--connect-timeout', '5', '--max-time', '15',
    '--silent', '--show-error', '--output', output,
    '--write-out', 'http=%{http_code};connect=%{http_connect};tls=%{ssl_verify_result}',
    targetUrl,
  ];
}

export async function probeLocalProxy({ localProxy, localPort, targetUrl = DEFAULT_TARGET_URL }) {
  const result = classifyCurlResult(await runProcess({
    executable: 'curl.exe',
    args: curlArgs(localProxy, 'NUL', targetUrl),
    timeoutMs: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  if (!result.ok) fail(`本地代理检查失败（curl 退出码 ${result.evidence.exitCode ?? '未知'}）；请确认 127.0.0.1:${localPort} 的无认证 HTTP 代理已启动。`);
  console.log('✅ 本地代理：TLS 有效，目标返回预期 401。');
}

const REMOTE_READ_SCRIPT = String.raw`
set -eu
file=$1
case "$file" in "~/"*) file="$HOME/$(printf '%s' "$file" | cut -c 3-)";; esac
if [ -L "$file" ]; then exit 41; fi
printf '__CODEX_E2E__\n'
if [ ! -e "$file" ]; then printf 'exists=0\nhash=missing\nmode=600\ncontent=\n'; exit 0; fi
if [ ! -f "$file" ]; then exit 41; fi
printf 'exists=1\nhash=%s\nmode=%s\ncontent=' "$(sha256sum "$file" | awk '{print $1}')" "$(stat -c '%a' "$file")"
base64 < "$file" | tr -d '\n'
printf '\n'
`;

export async function remoteRead(options, remoteSettings = DEFAULT_REMOTE_SETTINGS) {
  const stdout = await runSsh(options, REMOTE_READ_SCRIPT, [remoteSettings], 60_000, 'sh', '读取 Remote settings');
  const marker = stdout.lastIndexOf(RESULT_MARKER);
  if (marker < 0) fail('远端读取返回无法识别的结果。');
  const body = stdout.slice(marker + RESULT_MARKER.length);
  const match = body.match(/^exists=([01])\nhash=([a-f0-9]+|missing)\nmode=([0-7]+)\ncontent=([^\n]*)/);
  if (!match) fail('远端读取结果不完整。');
  const bytes = Buffer.from(match[4], 'base64');
  let text = null;
  if (match[1] === '1') {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      fail('Remote settings 不是有效 UTF-8。');
    }
  }
  return { exists: match[1] === '1', hash: match[2], mode: match[3], text };
}

const PREFLIGHT_SCRIPT = String.raw`
set -eu
for tool in sh bash curl base64 sha256sum mktemp mv cp rm rmdir chmod stat dirname basename find grep awk tr cut readlink date sleep; do
  command -v "$tool" >/dev/null 2>&1 || { printf '__CODEX_E2E__\nmissing=%s\n' "$tool"; exit 44; }
done
listener_tool=
for candidate in ss netstat; do
  if command -v "$candidate" >/dev/null 2>&1; then listener_tool=$candidate; break; fi
done
if [ -z "$listener_tool" ] && [ -r /proc/net/tcp ]; then listener_tool=proc; fi
[ -n "$listener_tool" ] || { printf '__CODEX_E2E__\nmissing=socket-inspection\n'; exit 44; }
set -- "$HOME"/.vscode-server/extensions/openai.chatgpt-*
count=0
extension=
for candidate do [ -d "$candidate" ] || continue; count=$((count + 1)); extension=$candidate; done
printf '__CODEX_E2E__\n'
if [ "$count" -ne 1 ]; then printf 'extensions=%s\n' "$count"; exit 45; fi
entry="$extension/out/extension.js"
[ -f "$entry" ] || { printf 'entry=missing\n'; exit 45; }
grep -F 'getConfiguration("http")' "$entry" >/dev/null || { printf 'http_config=missing\n'; exit 45; }
grep -F 'HTTP_PROXY' "$entry" >/dev/null || { printf 'http_proxy=missing\n'; exit 45; }
grep -F 'HTTPS_PROXY' "$entry" >/dev/null || { printf 'https_proxy=missing\n'; exit 45; }
grep -F 'app-server' "$entry" >/dev/null || { printf 'app_server=missing\n'; exit 45; }
printf 'extension=%s\nlistener_tool=%s\nstatic_chain=match\n' "$(basename "$extension")" "$listener_tool"
`;

function parsePreflight(stdout) {
  const marker = stdout.lastIndexOf(RESULT_MARKER);
  const body = marker >= 0 ? stdout.slice(marker + RESULT_MARKER.length) : '';
  const missing = body.match(/^missing=([A-Za-z0-9_-]+)$/m)?.[1];
  if (missing) fail(`远端缺少必需工具：${missing}。已停止且未进行配置写入。`);
  const extensionCount = body.match(/^extensions=(\d+)$/m)?.[1];
  if (extensionCount) fail(`远端 Codex 扩展候选数为 ${extensionCount}，无法唯一确认。`);
  const failedEvidence = body.match(/^(entry|http_config|http_proxy|https_proxy|app_server)=missing$/m)?.[1];
  if (failedEvidence) fail(`远端 Codex 扩展调用链证据缺失：${failedEvidence}。`);
  if (!/static_chain=match/.test(body)) fail('远端前置检查返回无法识别的脱敏结果。');
  const version = body.match(/^extension=(.+)$/m)?.[1] ?? '未知版本';
  const listenerTool = body.match(/^listener_tool=(ss|netstat|proc)$/m)?.[1];
  if (!listenerTool) fail('远端监听检查工具证据缺失。');
  return { version, listenerTool };
}

export async function preflightRemote(options) {
  const stdout = await runSsh(options, PREFLIGHT_SCRIPT, [], 60_000, 'sh', '检查远端工具与 Codex 扩展', [44, 45]);
  const result = parsePreflight(stdout);
  console.log(`✅ SSH 与远端工具：可用；监听检查使用 ${result.listenerTool}；远端扩展 ${result.version} 的静态调用链匹配。`);
  return result;
}

const PORT_SCRIPT = String.raw`
set -eu
port=$1
port_hex=$2
tool=$3
printf '__CODEX_E2E__\n'
case "$tool" in
  ss) ss -ltnH | awk -v p="$port" '$4 ~ (":" p "$") { print $4 }';;
  netstat) netstat -lnt 2>/dev/null | awk -v p="$port" 'NR > 2 && $4 ~ (":" p "$") { print $4 }';;
  proc)
    for table in /proc/net/tcp /proc/net/tcp6; do
      [ -r "$table" ] || continue
      awk -v p="$port_hex" '$4 == "0A" && $2 ~ (":" p "$") { print $2 }' "$table"
    done | while IFS= read -r address; do
      case "$address" in
        "0100007F:$port_hex") printf '127.0.0.1:%s\n' "$port";;
        *) printf 'unexpected=%s\n' "$address";;
      esac
    done
    ;;
  *) exit 44;;
esac
`;

export async function remoteListeners(options, listenerTool, remotePort = 17890, { strict = true } = {}) {
  const portHex = remotePort.toString(16).padStart(4, '0').toUpperCase();
  const stdout = await runSsh(options, PORT_SCRIPT, [String(remotePort), portHex, listenerTool], 60_000, 'sh', `检查远端端口 ${remotePort}`);
  const marker = stdout.lastIndexOf(RESULT_MARKER);
  if (marker < 0) fail('无法判断远端端口状态。');
  const listeners = stdout.slice(marker + RESULT_MARKER.length).trim().split(/\r?\n/).filter(Boolean);
  const unexpected = listeners.filter((value) => value !== `127.0.0.1:${remotePort}`);
  if (strict && unexpected.length) fail(`远端端口 ${remotePort} 存在非预期或非回环监听，请断开相关连接。`);
  return listeners;
}

export async function sshEffective(options) {
  const result = await runProcess({
    executable: openSshExecutables().ssh,
    args: ['-G', '-F', options.sshConfig, options.host],
    timeoutMs: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.exitCode !== 0 || result.timedOut) fail('ssh -G 无法解析目标配置。');
  return result.stdout.replace(/\r\n/g, '\n');
}

function normalizeEndpoint(value) {
  return value.replace(/^\[([^\]]+)\]:(\d+)$/, '$1:$2');
}

export function hasExpectedRemoteForward(effectiveText, remotePort, localPort) {
  return effectiveText.split('\n').some((line) => {
    const [keyword, listen, destination, extra] = line.trim().split(/\s+/);
    return keyword === 'remoteforward'
      && extra === undefined
      && normalizeEndpoint(listen) === `127.0.0.1:${remotePort}`
      && normalizeEndpoint(destination) === `127.0.0.1:${localPort}`;
  });
}

export function classifyEndpoint({ listeners, hasExpectedForward, remotePort }) {
  const expected = `127.0.0.1:${remotePort}`;
  if (listeners.some((value) => value !== expected) || listeners.length > 1) {
    return { status: 'fail', message: '远端端口存在非预期或非回环监听。', shouldProbeTarget: false };
  }
  if (listeners.length === 1 && !hasExpectedForward) {
    return { status: 'fail', message: '远端端口已被来源不明的监听占用。', shouldProbeTarget: false };
  }
  if (listeners.length === 1) {
    return { status: 'pass', message: '预期 IPv4 回环入口正在监听。', shouldProbeTarget: true };
  }
  if (hasExpectedForward) {
    return { status: 'unknown', message: '配置包含预期转发，但远端入口尚未监听；需要重连。', shouldProbeTarget: false };
  }
  return { status: 'pass', message: `候选远端端口 ${remotePort} 空闲。`, shouldProbeTarget: false };
}

const VERIFY_NETWORK_SCRIPT = String.raw`
set -eu
port=$1
code=0
result=$(curl -q --proxy "http://127.0.0.1:$port" --noproxy '' --connect-timeout 5 --max-time 15 --silent --show-error --output /dev/null --write-out 'http=%{http_code};connect=%{http_connect};tls=%{ssl_verify_result}' 'https://api.openai.com/v1/models' 2>/dev/null) || code=$?
printf '__CODEX_E2E__\nexit=%s;%s\n' "$code" "$result"
`;

function classifyRemoteNetwork(stdout) {
  const marker = stdout.lastIndexOf(RESULT_MARKER);
  const body = marker < 0 ? '' : stdout.slice(marker + RESULT_MARKER.length);
  const match = body.match(/exit=(\d+);http=(\d+);connect=(\d+);tls=(\d+)/);
  return classifyCurlResult({
    exitCode: match ? Number(match[1]) : null,
    stdout: match ? `http=${match[2]};connect=${match[3]};tls=${match[4]}` : '',
    stderr: '',
    timedOut: false,
  });
}

export async function probeRemoteTarget(options, remotePort) {
  return classifyRemoteNetwork(await runSsh(
    options,
    VERIFY_NETWORK_SCRIPT,
    [String(remotePort)],
    60_000,
    'sh',
    '验证远端代理与目标 HTTPS',
  ));
}

export async function checkConfiguredEndpoint(
  options,
  listenerTool,
  remotePort,
  dependencies = {},
) {
  const operations = { remoteListeners, probeRemoteTarget, ...dependencies };
  const listeners = await operations.remoteListeners(options, listenerTool, remotePort);
  if (!listeners.length) {
    return { status: 'unknown', message: '配置无增量，但端点尚未监听；请重连 VS Code Remote SSH。' };
  }
  const network = await operations.probeRemoteTarget(options, remotePort);
  if (!network.ok) fail(`已知回环端点不可用：${network.message}`);
  return { status: 'pass', message: '配置无增量，已知回环端点及目标 HTTPS 检查通过。' };
}

function safeFailureMessage(error, fallback) {
  return error instanceof ExpectedError ? error.message : fallback;
}

function rethrowCancellation(error) {
  if (error instanceof CancelledError) throw error;
}

export async function inspectTarget(options, dependencies = {}) {
  const {
    host,
    sshConfig,
    localProxy,
    localPort,
    remotePort,
    remoteSettings = DEFAULT_REMOTE_SETTINGS,
    targetUrl = DEFAULT_TARGET_URL,
  } = options;
  const operations = {
    runProcess,
    sshEffective,
    preflightRemote,
    remoteRead,
    remoteListeners,
    probeRemoteTarget,
    ...dependencies,
  };
  const transportOptions = { host, sshConfig };
  const checks = [];
  const snapshot = { sshEffective: null, remoteSettings: null, listenerTool: null, listeners: [] };

  try {
    const localResult = classifyCurlResult(await operations.runProcess({
      executable: 'curl.exe',
      args: curlArgs(localProxy, 'NUL', targetUrl),
      timeoutMs: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    checks.push({ layer: 'local-proxy', status: localResult.ok ? 'pass' : 'fail', message: localResult.message });
  } catch (error) {
    rethrowCancellation(error);
    checks.push({ layer: 'local-proxy', status: 'fail', message: '无法启动本地 curl 检查。' });
  }

  try {
    snapshot.sshEffective = await operations.sshEffective(transportOptions);
    const preflight = await operations.preflightRemote(transportOptions);
    snapshot.listenerTool = preflight.listenerTool;
    snapshot.remoteSettings = await operations.remoteRead(transportOptions, remoteSettings);
    checks.push({ layer: 'ssh', status: 'pass', message: `SSH 与远端工具可用；Codex 扩展 ${preflight.version} 调用链匹配。` });
  } catch (error) {
    rethrowCancellation(error);
    checks.push({ layer: 'ssh', status: 'fail', message: safeFailureMessage(error, 'SSH 或远端只读检查失败。') });
    checks.push({ layer: 'remote-endpoint', status: 'unknown', message: 'SSH 检查未通过，无法判断远端入口。' });
    checks.push({ layer: 'target-https', status: 'unknown', message: '远端入口状态未知，未执行目标 HTTPS 检查。' });
    return { ok: false, checks, snapshot };
  }

  const hasExpectedForward = hasExpectedRemoteForward(snapshot.sshEffective, remotePort, localPort);
  try {
    snapshot.listeners = await operations.remoteListeners(transportOptions, snapshot.listenerTool, remotePort, { strict: false });
  } catch (error) {
    rethrowCancellation(error);
    checks.push({ layer: 'remote-endpoint', status: 'fail', message: safeFailureMessage(error, '远端入口检查失败。') });
    checks.push({ layer: 'target-https', status: 'unknown', message: '远端入口检查失败，未执行目标 HTTPS 检查。' });
    return { ok: false, checks, snapshot };
  }

  const endpoint = classifyEndpoint({ listeners: snapshot.listeners, hasExpectedForward, remotePort });
  checks.push({ layer: 'remote-endpoint', status: endpoint.status, message: endpoint.message });
  if (!endpoint.shouldProbeTarget) {
    checks.push({ layer: 'target-https', status: 'unknown', message: '远端入口尚不可用于目标 HTTPS 检查。' });
    return { ok: checks.every((check) => check.status !== 'fail'), checks, snapshot };
  }

  try {
    const network = await operations.probeRemoteTarget(transportOptions, remotePort);
    checks.push({ layer: 'target-https', status: network.ok ? 'pass' : 'fail', message: network.message });
  } catch (error) {
    rethrowCancellation(error);
    checks.push({ layer: 'target-https', status: 'fail', message: safeFailureMessage(error, '目标 HTTPS 检查失败。') });
  }
  return { ok: checks.every((check) => check.status !== 'fail'), checks, snapshot };
}
