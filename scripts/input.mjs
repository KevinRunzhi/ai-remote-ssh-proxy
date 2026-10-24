import path from 'node:path';
import { ExpectedError } from './ssh.mjs';

function fail(message) { throw new ExpectedError(message); }
export function port(value, minimum = 1024) {
  if (!(typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))) fail('端口必须是整数。');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > 65535) fail(`端口须为 ${minimum}–65535 的整数。`);
  return number;
}
export function alias(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value)) fail('SSH alias 格式不受支持。');
  return value;
}
export function hostname(value) {
  if (typeof value !== 'string' || value.length > 253 || !value.length) fail('主机名不受支持。');
  if (/^[0-9.]+$/.test(value)) {
    const parts = value.split('.');
    if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) fail('IPv4 地址不合法。');
  } else if (value.split('.').some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) fail('仅支持普通 ASCII 主机名或 IPv4。');
  return value.toLowerCase();
}
export function username(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(value)) fail('Linux 用户名格式不受支持。');
  return value;
}
export function configPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) fail('SSH config 必须是本机绝对路径。');
  return path.resolve(value);
}
export function normalizeProxy(value) {
  if (typeof value !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/i.test(value)) fail('本机代理地址无效。');
  let parsed;
  try { parsed = new URL(value); } catch { fail('本机代理地址无效。'); }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
      || parsed.username || parsed.password || !parsed.port || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) fail('仅支持无认证、无路径的本机回环 HTTP 代理。');
  const localPort = port(parsed.port);
  return { localProxy: `http://127.0.0.1:${localPort}`, localPort };
}
export function normalizeConnection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('连接字段无效。');
  const keys = value.inputMode === 'alias' ? ['inputMode', 'host', 'sshConfig'] : ['inputMode', 'hostname', 'username', 'sshPort', 'sshConfig'];
  if (Object.keys(value).some((key) => !keys.includes(key))) fail('连接包含不支持字段，请使用简单命令或分字段输入。');
  if (value.inputMode === 'alias') return { inputMode: 'alias', host: alias(value.host), ...(value.sshConfig !== undefined ? { sshConfig: configPath(value.sshConfig) } : {}) };
  if (value.inputMode !== 'direct') fail('请选择 direct 或 alias 连接模式。');
  return { inputMode: 'direct', hostname: hostname(value.hostname), username: username(value.username), sshPort: port(value.sshPort ?? 22, 1), ...(value.sshConfig !== undefined ? { sshConfig: configPath(value.sshConfig) } : {}) };
}

// 限定分词器；不是 Shell，也不支持任何变量或转义执行。
export function parseSshCommand(command) {
  if (typeof command !== 'string' || command.length > 2048 || /[\x00-\x1f\x7f;&|<>`$\\]/.test(command)) fail('SSH 命令包含不支持的字符，请分字段输入。');
  const tokens = [];
  let word = '', quote = null, started = false;
  for (const char of command.trim()) {
    if (quote) { if (char === quote) quote = null; else word += char; started = true; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (char === ' ') { if (started) { tokens.push(word); word = ''; started = false; } }
    else { word += char; started = true; }
  }
  if (quote) fail('SSH 命令引号不匹配。');
  if (started) tokens.push(word);
  if (tokens.shift() !== 'ssh') fail('仅支持以 ssh 开始的简单连接命令。');
  let sshPort, user, destination;
  while (tokens.length) {
    const token = tokens.shift();
    if (token === '-p' || token === '-l') {
      if (destination !== undefined || !tokens.length) fail('SSH 选项必须在目标之前且有值。');
      const value = tokens.shift();
      if (token === '-p') { if (sshPort !== undefined) fail('SSH 端口重复。'); sshPort = port(value, 1); }
      else { if (user !== undefined) fail('SSH 用户重复。'); user = username(value); }
    } else {
      if (token.startsWith('-') || destination !== undefined) fail('不支持该 SSH 选项或远端命令。');
      destination = token;
    }
  }
  if (!destination) fail('缺少 SSH 目标。');
  const split = destination.split('@');
  if (split.length > 2) fail('SSH 目标格式无效。');
  if (split.length === 2) {
    if (user !== undefined) fail('SSH 用户重复或矛盾。');
    return normalizeConnection({ inputMode: 'direct', username: split[0], hostname: split[1], sshPort: sshPort ?? 22 });
  }
  if (user !== undefined) return normalizeConnection({ inputMode: 'direct', username: user, hostname: destination, sshPort: sshPort ?? 22 });
  if (sshPort !== undefined) fail('alias 命令不接受端口覆盖，请分字段输入。');
  return normalizeConnection({ inputMode: 'alias', host: destination });
}
