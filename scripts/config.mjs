import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { alias as validateAlias, hostname as validateHostname, username as validateUsername, port as validatePort } from './input.mjs';

import { applyEdits as applyJsoncEdits, parseTree } from 'jsonc-parser';

const BEGIN_MARKER = '# BEGIN codex-proxy-e2e';
const END_MARKER = '# END codex-proxy-e2e';

export class ConfigError extends Error {}

function fail(message) {
  throw new ConfigError(message);
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function splitLines(text) {
  return text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markerCount(text, marker) {
  return text.split(marker).length - 1;
}

function loopbackPort(endpoint) {
  return endpoint.match(/^\[?127\.0\.0\.1\]?:(\d+)$/)?.[1] ?? null;
}

function forwardedPort(endpoint) {
  return endpoint.match(/^(?:\d+|.*:(\d+))$/)?.[1] ?? (/^\d+$/.test(endpoint) ? endpoint : null);
}

function prepareSshEdit(text, host, localPort, remotePort) {
  if (/^\s*(?:Include|Match)\b/im.test(text)) fail('SSH config 含 Include 或 Match，停止修改。');

  const desired = `RemoteForward 127.0.0.1:${remotePort} 127.0.0.1:${localPort}`;
  const beginCount = markerCount(text, BEGIN_MARKER);
  const endCount = markerCount(text, END_MARKER);
  if (beginCount !== endCount || beginCount > 1) fail('SSH config 中存在不完整或重复的工具标记。');

  const lines = splitLines(text);
  const hostLines = [];
  for (let index = 0; index < lines.length; index += 1) {
    const body = lines[index].replace(/[\r\n]+$/, '');
    const match = body.match(/^\s*Host\s+([^#]+?)(?:\s+#.*)?$/i);
    if (!match) continue;
    const aliases = match[1].trim().split(/\s+/);
    if (aliases.includes(host)) hostLines.push({ index, aliases });
  }
  if (hostLines.length !== 1 || hostLines[0].aliases.length !== 1) {
    fail('目标必须位于唯一、单 alias 的字面 Host 块。');
  }

  const start = hostLines[0].index;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*Host\s+/i.test(lines[index])) {
      end = index;
      break;
    }
  }

  const block = lines.slice(start + 1, end);
  let ownedSnippet = null;
  if (beginCount === 1) {
    const markerPattern = new RegExp(
      `^([ \\t]*)${escapeRegExp(BEGIN_MARKER)}\\r?\\n\\1${escapeRegExp(desired)}\\r?\\n\\1${escapeRegExp(END_MARKER)}(?:\\r?\\n|$)`,
      'm',
    );
    const marked = text.match(markerPattern)?.[0];
    const blockText = block.join('');
    if (!marked || !blockText.includes(marked)) fail('工具标记内容或位置与目标配置不符。');
    ownedSnippet = marked;
  }

  let equivalent = false;
  for (const line of block) {
    const match = line.replace(/[\r\n]+$/, '').match(/^\s*RemoteForward\s+(\S+)(?:\s+(\S+))?(?:\s+#.*)?$/i);
    if (!match) continue;
    const [remote, local] = match.slice(1);
    if (loopbackPort(remote) === String(remotePort) && loopbackPort(local) === String(localPort)) {
      equivalent = true;
      continue;
    }
    if (forwardedPort(remote) === String(remotePort)) {
      fail(`远端端口 ${remotePort} 已有不同转发映射。`);
    }
  }
  if (ownedSnippet) return { text, changed: false, owned: true, snippet: ownedSnippet };
  if (equivalent) return { text, changed: false, owned: false, snippet: '' };

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = block.map((line) => line.match(/^(\s+)\S/)?.[1]).find(Boolean) ?? '    ';
  const offset = lines.slice(0, end).reduce((sum, line) => sum + line.length, 0);
  const leadingEol = offset > 0 && !/[\r\n]$/.test(text.slice(0, offset)) ? eol : '';
  const snippet = `${leadingEol}${indent}${BEGIN_MARKER}${eol}${indent}${desired}${eol}${indent}${END_MARKER}${eol}`;
  return {
    text: `${text.slice(0, offset)}${snippet}${text.slice(offset)}`,
    changed: true,
    owned: true,
    snippet,
  };
}

function formattingOptions(text) {
  const indent = text.match(/\n([ \t]+)\S/)?.[1] ?? '  ';
  return {
    insertSpaces: !indent.includes('\t'),
    tabSize: indent.includes('\t') ? 1 : indent.length,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
}

function rootPropertyMap(root) {
  const properties = new Map();
  for (const property of root.children ?? []) {
    const key = property.children?.[0]?.value;
    if (typeof key !== 'string') continue;
    const entries = properties.get(key) ?? [];
    entries.push(property.children?.[1]);
    properties.set(key, entries);
  }
  return properties;
}

function parseSettings(text) {
  const errors = [];
  const root = parseTree(text.startsWith('\uFEFF') ? text.slice(1) : text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || root?.type !== 'object') fail('Remote settings 不是可安全局部编辑的 JSONC 对象。');
  const properties = rootPropertyMap(root);
  const checkDuplicates = (node) => {
    if (node.type === 'object') {
      const keys = new Set();
      for (const property of node.children ?? []) {
        const key = property.children[0].value;
        if (keys.has(key)) fail('Remote settings 含重复键，停止修改。');
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) checkDuplicates(child);
  };
  checkDuplicates(root);
  return properties;
}

function prepareSettingsEdit(originalText, remotePort) {
  const existed = originalText !== null;
  const initial = originalText ?? '{}\n';
  const expected = new Map([
    ['http.useLocalProxyConfiguration', false],
    ['http.proxy', `http://127.0.0.1:${remotePort}`],
  ]);
  const initialProperties = parseSettings(initial);
  for (const [key, value] of expected) {
    const node = initialProperties.get(key)?.[0];
    if (node && node.value !== value) fail(`Remote settings 已有不同的 ${key}，停止修改且不保存其值。`);
  }

  let text = initial;
  const inverseSteps = [];
  const properties = {};
  for (const [key, value] of expected) {
    const currentNode = parseSettings(text).get(key)?.[0];
    if (currentNode?.value === value) {
      properties[key] = { owned: false, original: 'equivalent' };
      continue;
    }
    const bomLength = text.startsWith('\uFEFF') ? 1 : 0;
    const root = parseTree(text.slice(bomLength), [], { allowTrailingComma: true, disallowComments: false });
    const format = formattingOptions(text);
    const indent = format.insertSpaces ? ' '.repeat(format.tabSize) : '\t';
    // 只在对象开头插入。旧字符一个也不改，逆操作无需保存可能含秘密的旧行。
    const offset = root.offset + bomLength + 1;
    const insertion = `${format.eol}${indent}${JSON.stringify(key)}: ${JSON.stringify(value)}${root.children?.length ? ',' : ''}${format.eol}`;
    const next = applyJsoncEdits(text, [{ offset, length: 0, content: insertion }]);
    parseSettings(next);
    inverseSteps.push({ offset, length: insertion.length, content: '' });
    properties[key] = { owned: true, original: 'missing' };
    text = next;
  }
  return { text, changed: text !== initial, existed, inverseSteps, properties };
}

function undoSettings(text, inverseSteps) {
  let restored = text;
  for (const inverse of [...inverseSteps].reverse()) restored = applyJsoncEdits(restored, [inverse]);
  return restored;
}

function assertInputs({ sshText, settingsText, host, localPort, remotePort }) {
  if (typeof sshText !== 'string') fail('sshText 必须是字符串。');
  if (settingsText !== null && typeof settingsText !== 'string') fail('settingsText 必须是字符串或 null。');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(host ?? '')) fail('SSH Host alias 格式不合法。');
  for (const [name, value] of [['localPort', localPort], ['remotePort', remotePort]]) {
    if (!Number.isInteger(value) || value < 1024 || value > 65535) fail(`${name} 必须是 1024–65535 的整数。`);
  }
}

export function prepareEdits(input) {
  assertInputs(input);
  const ssh = prepareSshEdit(input.sshText, input.host, input.localPort, input.remotePort);
  const settings = prepareSettingsEdit(input.settingsText, input.remotePort);
  const recovery = {
    ssh: {
      owned: ssh.owned && ssh.changed,
      snippet: ssh.changed ? ssh.snippet : '',
      beforeHash: sha256(input.sshText),
      afterHash: sha256(ssh.text),
    },
    settings: {
      owned: settings.changed,
      existed: settings.existed,
      properties: settings.properties,
      inverseSteps: settings.inverseSteps,
      beforeHash: input.settingsText === null ? 'missing' : sha256(input.settingsText),
      afterHash: sha256(settings.text),
    },
  };
  return {
    sshText: ssh.text,
    settingsText: settings.text,
    changed: ssh.changed || settings.changed,
    recovery,
  };
}

export function restoreSshEdit({ sshText, recovery }) {
  if (sha256(sshText) !== recovery.afterHash) {
    fail('当前 SSH config 摘要与应用后状态不符；停止恢复以保留用户修改。');
  }
  let restoredSsh = sshText;
  if (recovery.owned) {
    const snippet = recovery.snippet;
    if (!snippet || restoredSsh.split(snippet).length !== 2) fail('SSH 工具片段无法唯一定位。');
    restoredSsh = restoredSsh.replace(snippet, '');
  }
  if (sha256(restoredSsh) !== recovery.beforeHash) fail('SSH config 无法按记录精确恢复。');
  return restoredSsh;
}

export function restoreSettingsEdit({ settingsText, recovery }) {
  if (sha256(settingsText) !== recovery.afterHash) {
    fail('当前 Remote settings 摘要与应用后状态不符；停止恢复以保留用户修改。');
  }
  const restoredSettings = undoSettings(settingsText, recovery.inverseSteps);
  if (recovery.existed && sha256(restoredSettings) !== recovery.beforeHash) {
    fail('Remote settings 无法按记录精确恢复。');
  }
  return recovery.existed ? restoredSettings : null;
}

export function restoreEdits({ sshText, settingsText, recovery }) {
  return {
    sshText: restoreSshEdit({ sshText, recovery: recovery.ssh }),
    settingsText: restoreSettingsEdit({ settingsText, recovery: recovery.settings }),
  };
}

// v0.3 纯计划：连接与代理分别拥有恢复依据；不访问文件或外部进程。
const V3_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function planId(value) { if (typeof value !== 'string' || !V3_ID.test(value)) fail('配置归属标识无效。'); return value; }
function checkedText(text) {
  if (text !== null && (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024 || /\u0000/.test(text))) fail('配置文本类型、编码或大小不受支持。');
  return text;
}
export function contentSnapshot(text) {
  checkedText(text);
  return { exists: text !== null, sha256: text === null ? null : sha256(text) };
}
function resourcePlan(kind, filePath, before, after, details) {
  checkedText(after);
  return { kind, path: filePath, text: after, changed: before !== after,
    expectedBefore: contentSnapshot(before), expectedAfter: contentSnapshot(after), ...details };
}
function sshLayout(text, selectedAlias) {
  checkedText(text);
  const source = text ?? '';
  if (/^\s*(?:Include|Match)(?:\s|=)/im.test(source)) fail('SSH config 含 Include 或 Match，停止修改。');
  const lines = []; let offset = 0;
  for (const raw of splitLines(source)) {
    const bom = offset === 0 && raw.startsWith('\uFEFF') ? 1 : 0;
    lines.push({ raw, offset: offset + bom, body: raw.slice(bom).replace(/[\r\n]+$/, '') }); offset += raw.length;
  }
  const stack = [], seen = new Set();
  for (const line of lines) {
    if (!/# (?:BEGIN|END) codex-(?:remote-|proxy-e2e)/.test(line.body)) continue;
    const marker = line.body.trim().match(/^# (BEGIN|END) (codex-proxy-e2e|codex-remote-(?:connection|forward) [a-f0-9-]+(?: [a-f0-9-]+)?)$/);
    if (!marker) fail('SSH 工具标记不完整。');
    if (marker[2].startsWith('codex-remote-')) {
      const [kind, target, cycle] = marker[2].split(' ');
      planId(target);
      if (kind === 'codex-remote-forward') planId(cycle);
      else if (cycle !== undefined) fail('SSH 工具标记无效。');
    }
    if (marker[1] === 'BEGIN') {
      if (seen.has(marker[2])) fail('SSH 工具标记重复。');
      seen.add(marker[2]); stack.push(marker[2]);
    } else if (stack.pop() !== marker[2]) fail('SSH 工具标记顺序不完整。');
  }
  if (stack.length) fail('SSH 工具标记不完整。');
  const hosts = [];
  for (let index = 0; index < lines.length; index++) {
    const body = lines[index].body;
    if (/^\s*Host\s*=/i.test(body)) fail('SSH Host 布局不受支持。');
    const match = body.match(/^\s*Host\s+([^#]+?)(?:\s*#.*)?$/i);
    if (!match) continue;
    if (/["']/.test(match[1])) fail('SSH Host 引号布局不受支持。');
    hosts.push({ line: index, aliases: match[1].trim().split(/\s+/), offset: lines[index].offset });
  }
  const selected = hosts.filter((host) => host.aliases.some((entry) => entry.toLowerCase() === selectedAlias.toLowerCase()));
  if (selected.length > 1 || selected[0]?.aliases.length > 1) fail('目标必须位于唯一、单 alias 的字面 Host 块。');
  const host = selected[0] ?? null;
  const index = hosts.indexOf(host);
  return { source, lines, hosts, host, end: host ? hosts[index + 1]?.offset ?? source.length : null,
    eol: source.includes('\r\n') ? '\r\n' : '\n' };
}

export function planConnection({ sshText, filePath, alias, hostname, username, sshPort = 22, targetId, reuse = false }) {
  validateAlias(alias); planId(targetId);
  const layout = sshLayout(sshText, alias);
  if (reuse) {
    if (!layout.host) fail('已有 alias 不存在。');
    return resourcePlan('connection', filePath, sshText, sshText, { owned: false, preview: [],
      firstRecovery: { owned: false, existed: true, beforeHash: sha256(sshText), afterHash: sha256(sshText), snippet: '' } });
  }
  if (layout.host) fail('新连接 alias 已占用，请生成另一个 alias。');
  validateHostname(hostname); validateUsername(username); validatePort(sshPort, 1);
  const insertion = layout.hosts[0]?.offset ?? layout.source.length;
  const prefix = layout.source.slice(0, insertion);
  const eol = layout.eol;
  const leading = prefix.length && !/[\r\n\uFEFF]$/.test(prefix) ? eol : '';
  const snippet = `${leading}# BEGIN codex-remote-connection ${targetId}${eol}Host ${alias}${eol}    HostName ${hostname}${eol}    User ${username}${eol}    Port ${sshPort}${eol}# END codex-remote-connection ${targetId}${eol}`;
  const after = prefix + snippet + layout.source.slice(insertion);
  return resourcePlan('connection', filePath, sshText, after, { owned: true, preview: [snippet.trim()],
    firstRecovery: { owned: true, existed: sshText !== null, beforeHash: sshText === null ? null : sha256(sshText), afterHash: sha256(after), snippet } });
}

export function planForwarding({ sshText, filePath, alias, localPort, remotePort, targetId, cycleId }) {
  validateAlias(alias); validatePort(localPort); validatePort(remotePort); planId(targetId); planId(cycleId);
  const layout = sshLayout(sshText, alias);
  if (!layout.host) fail('连接 alias 尚未建立，不能配置转发。');
  const targetLines = layout.lines.filter((line) => line.offset > layout.host.offset && line.offset < layout.end);
  const globalLines = layout.lines.filter((line) => line.offset < layout.hosts[0].offset);
  let equivalent = false;
  for (const line of [...globalLines, ...targetLines]) {
    const match = line.body.match(/^\s*RemoteForward\s+(\S+)\s+(\S+)(?:\s+#.*)?$/i);
    if (!match) continue;
    if (forwardedPort(match[1]) !== String(remotePort)) continue;
    if (loopbackPort(match[1]) !== String(remotePort) || loopbackPort(match[2]) !== String(localPort)) fail('远端端口已有不同或非回环转发映射。');
    equivalent = true;
  }
  const label = `codex-remote-forward ${targetId} ${cycleId}`;
  if (layout.source.includes(`# BEGIN ${label}`)) fail('当前周期已有标记，必须先按写入意图核对，不能取得新所有权。');
  if (equivalent) return resourcePlan('forwarding', filePath, sshText, sshText, { owned: false, preview: [],
    firstRecovery: { owned: false, existed: true, beforeHash: sha256(sshText), afterHash: sha256(sshText), snippet: '' } });
  const hostLine = layout.lines[layout.host.line];
  const insertion = hostLine.offset + hostLine.raw.length - (hostLine.raw.startsWith('\uFEFF') ? 1 : 0);
  const before = layout.source.slice(0, insertion);
  const leading = /[\r\n]$/.test(before) ? '' : layout.eol;
  const snippet = `${leading}    # BEGIN ${label}${layout.eol}    RemoteForward 127.0.0.1:${remotePort} 127.0.0.1:${localPort}${layout.eol}    # END ${label}${layout.eol}`;
  const after = before + snippet + layout.source.slice(insertion);
  return resourcePlan('forwarding', filePath, sshText, after, { owned: true, preview: [snippet.trim()],
    firstRecovery: { owned: true, existed: true, beforeHash: sha256(sshText), afterHash: sha256(after), snippet } });
}

export function planSettings({ settingsText, filePath, remotePort }) {
  checkedText(settingsText); validatePort(remotePort);
  const prepared = prepareSettingsEdit(settingsText, remotePort);
  return resourcePlan('settings', filePath, settingsText, prepared.text, { owned: prepared.changed,
    preview: [...(!prepared.changed ? ['复用已有等价代理字段，不改写文件，也不取得移除所有权'] : []),
      'http.useLocalProxyConfiguration = false', `http.proxy = http://127.0.0.1:${remotePort}`],
    firstRecovery: { owned: prepared.changed, existed: prepared.existed, properties: prepared.properties,
      inverseSteps: prepared.inverseSteps, beforeHash: settingsText === null ? null : sha256(settingsText), afterHash: sha256(prepared.text) } });
}

export function planResourceRestore({ kind, text, filePath, firstRecovery }) {
  checkedText(text);
  const recovery = firstRecovery;
  if (!recovery || typeof recovery.owned !== 'boolean') fail('缺少资源恢复依据。');
  if (!recovery.owned) return resourcePlan(kind, filePath, text, text, { owned: false, preview: ['保留用户原有配置'] });
  if (text === null || sha256(text) !== recovery.afterHash) fail('当前摘要与应用后状态不符；保留用户修改。');
  let after;
  if (kind === 'settings') after = restoreSettingsEdit({ settingsText: text, recovery });
  else {
    if (!['connection', 'forwarding'].includes(kind)) fail('未知资源类型。');
    after = restoreSshEdit({ sshText: text, recovery: recovery.existed ? recovery : { ...recovery, beforeHash: sha256('') } });
    if (!recovery.existed) {
      if (after !== '') fail('原本不存在的 SSH config 含其他内容，停止删除。');
      after = null;
    }
  }
  return resourcePlan(kind, filePath, text, after, { owned: true, preview: [kind === 'settings' ? '恢复工具添加的代理字段' : `移除工具添加的 ${kind} 片段`] });
}

async function assertRegularFile(filePath, fileSystem = fs) {
  let stat;
  try {
    stat = await fileSystem.lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`文件不存在：${filePath}`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`拒绝处理链接或非普通文件：${filePath}`);
  return stat;
}

export async function atomicLocalWrite({ filePath, expectedHash, text }, dependencies = {}) {
  const fileSystem = dependencies.fs ?? fs;
  const stat = await assertRegularFile(filePath, fileSystem);
  const current = await fileSystem.readFile(filePath, 'utf8');
  if (sha256(current) !== expectedHash) fail(`写入前摘要已变化，未修改：${filePath}`);
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.codex-e2e-${process.pid}-${Date.now()}`);
  let handle;
  try {
    handle = await fileSystem.open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, stat.mode);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporary, filePath);
    if (sha256(await fileSystem.readFile(filePath, 'utf8')) !== sha256(text)) fail(`替换后复读失败：${filePath}`);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fileSystem.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function saveRecoveryRecord({ directory, record }, dependencies = {}) {
  const fileSystem = dependencies.fs ?? fs;
  const restrictDirectory = dependencies.restrictDirectory;
  if (typeof restrictDirectory !== 'function') fail('未提供恢复目录访问限制，未修改配置。');
  await fileSystem.mkdir(directory, { recursive: true });
  await restrictDirectory(directory);
  const file = path.join(directory, 'active.json');
  let handle;
  try {
    handle = await fileSystem.open(file, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    if (error.code === 'EEXIST') fail('已有未移除的目标记录。');
    throw error;
  } finally {
    if (handle) await handle.close();
  }
  return file;
}

export async function restrictWindowsDirectory(directory, dependencies = {}) {
  const runProcess = dependencies.runProcess;
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32') fail('首版仅支持 Windows 本地。');
  if (typeof runProcess !== 'function') fail('无法限制恢复目录访问权限。');
  const identity = await runProcess({ executable: 'whoami.exe', args: ['/user', '/fo', 'csv', '/nh'] });
  const sid = identity.stdout.match(/"(S-1-[0-9-]+)"/)?.[1];
  if (identity.exitCode !== 0 || !sid) fail('无法取得当前用户 SID，未保存恢复信息。');
  const acl = await runProcess({
    executable: 'icacls.exe',
    args: [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`],
  });
  if (acl.exitCode !== 0) fail('无法把恢复目录限制为当前用户，未修改配置。');
}

const REMOTE_PREFLIGHT_SCRIPT = String.raw`
set -eu
for tool in awk base64 cut sha256sum stat mktemp cp chmod mv dirname rm rmdir tr; do command -v "$tool" >/dev/null 2>&1 || exit 44; done
printf '__CODEX_CONFIG__\nready=1\n'
`;

const CREATE_STAGE_SCRIPT = String.raw`
set -eu
token=$1
name=$2
case "$token" in *[!A-Za-z0-9_-]*|'') exit 47;; esac
case "$name" in */*|'') exit 47;; esac
umask 077
stage="$HOME/.codex-proxy-e2e-$token"
mkdir "$stage"
chmod 700 "$stage"
printf '__CODEX_CONFIG__\nstage=%s\nfile=%s\n' "$(printf '%s' "$stage" | base64 | tr -d '\n')" "$(printf '%s' "$stage/$name" | base64 | tr -d '\n')"
`;

const CLEAN_STAGE_SCRIPT = String.raw`
set -eu
stage=$1
file=$2
case "$file" in "$stage"/*) ;; *) exit 47;; esac
rm -f -- "$file"
rmdir -- "$stage"
printf '__CODEX_CONFIG__\nclean=1\n'
`;

const REMOTE_WRITE_SCRIPT = String.raw`
set -eu
file=$1
expected=$2
mode=$3
stage=$4
uploaded=$5
uploaded_hash=$6
case "$file" in "~/"*) file="$HOME/$(printf '%s' "$file" | cut -c 3-)";; esac
if [ -L "$file" ]; then exit 41; fi
if [ -e "$file" ]; then current=$(sha256sum "$file" | awk '{print $1}'); else current=missing; fi
[ "$current" = "$expected" ] || exit 42
case "$uploaded" in "$stage"/*) ;; *) exit 47;; esac
[ -f "$uploaded" ] && [ ! -L "$uploaded" ] || exit 47
[ "$(stat -c '%a' "$stage")" = 700 ] || exit 48
chmod 600 "$uploaded"
[ "$(stat -c '%a' "$uploaded")" = 600 ] || exit 48
[ "$(sha256sum "$uploaded" | awk '{print $1}')" = "$uploaded_hash" ] || exit 48
directory=$(dirname "$file")
[ -d "$directory" ] || exit 43
temporary=$(mktemp "$directory/.codex-proxy-e2e.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM
cp -- "$uploaded" "$temporary"
chmod "$mode" "$temporary"
mv -f "$temporary" "$file"
trap - EXIT HUP INT TERM
sha256sum "$file" | awk '{print $1}'
`;

const REMOTE_DELETE_SCRIPT = String.raw`
set -eu
file=$1
expected=$2
case "$file" in "~/"*) file="$HOME/$(printf '%s' "$file" | cut -c 3-)";; esac
[ -f "$file" ] && [ ! -L "$file" ] || exit 41
[ "$(sha256sum "$file" | awk '{print $1}')" = "$expected" ] || exit 42
rm -- "$file"
[ ! -e "$file" ] || exit 49
printf '__CODEX_CONFIG__\ndeleted=1\n'
`;

function decodeStage(stdout) {
  const marker = stdout.lastIndexOf('__CODEX_CONFIG__\n');
  const body = marker < 0 ? '' : stdout.slice(marker + '__CODEX_CONFIG__\n'.length);
  const decode = (name) => Buffer.from(body.match(new RegExp(`^${name}=([^\\n]+)$`, 'm'))?.[1] ?? '', 'base64').toString('utf8');
  const stage = decode('stage');
  const file = decode('file');
  if (!stage.startsWith('/') || /[\0\r\n]/.test(stage) || /[\0\r\n]/.test(file) || !file.startsWith(`${stage}/`)) {
    fail('远端暂存路径无法安全识别。');
  }
  return { stage, file };
}

async function restrictedTemporaryFile(directory, text, dependencies) {
  const fileSystem = dependencies.fs ?? fs;
  if (typeof dependencies.restrictDirectory !== 'function') fail('未提供本地暂存目录访问限制。');
  await fileSystem.mkdir(directory, { recursive: true });
  await dependencies.restrictDirectory(directory);
  const file = path.join(directory, `upload-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fileSystem.open(file, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  let closed = false;
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    closed = true;
  } catch (error) {
    if (!closed) await handle.close().catch(() => {});
    try {
      await fileSystem.rm(file, { force: true });
    } catch {
      fail(`无法清理本地暂存文件：${file}`);
    }
    throw error;
  }
  return file;
}

export async function writeRemoteSettings({
  options,
  remotePath,
  expectedHash,
  text,
  mode = '600',
  temporaryDirectory,
  onStaging = async () => {},
}, dependencies = {}) {
  const { runSsh, runScp } = dependencies;
  if (typeof runSsh !== 'function' || typeof runScp !== 'function') fail('远端写入依赖不完整。');
  if (!/^[0-7]{3,4}$/.test(mode)) fail('远端文件权限格式不合法。');

  const preflight = await runSsh(options, REMOTE_PREFLIGHT_SCRIPT, [], 30_000, 'sh', '检查远端写入工具');
  if (!/^ready=1$/m.test(preflight)) fail('远端缺少安全写入所需工具。');

  const localFile = await restrictedTemporaryFile(temporaryDirectory, text, dependencies);
  let staging = null;
  let cleanupError = null;
  try {
    const token = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
    staging = decodeStage(await runSsh(
      options,
      CREATE_STAGE_SCRIPT,
      [token, 'settings upload.json'],
      30_000,
      'sh',
      '创建远端私有暂存目录',
    ));
    await onStaging(staging.stage);
    await runScp(options, localFile, staging.file, '上传 Remote settings 暂存文件');
    const resultingHash = (await runSsh(
      options,
      REMOTE_WRITE_SCRIPT,
      [remotePath, expectedHash, mode, staging.stage, staging.file, sha256(text)],
      60_000,
      'sh',
      '写入 Remote settings',
    )).trim().split(/\s+/).at(-1);
    if (resultingHash !== sha256(text)) fail('远端替换后复读摘要不匹配。');
  } finally {
    if (staging) {
      try {
        const cleaned = await runSsh(options, CLEAN_STAGE_SCRIPT, [staging.stage, staging.file], 30_000, 'sh', '清理远端暂存目录');
        if (!/^clean=1$/m.test(cleaned)) fail('远端暂存清理结果无法确认。');
        await onStaging(null);
      } catch (error) {
        cleanupError = error;
      }
    }
    await (dependencies.fs ?? fs).rm(localFile, { force: true }).catch(() => {});
    if (cleanupError) fail(`远端暂存清理结果不明：${staging.stage}`);
  }
}

export async function deleteRemoteSettings({ options, remotePath, expectedHash }, dependencies = {}) {
  if (typeof dependencies.runSsh !== 'function') fail('远端删除依赖不完整。');
  const result = await dependencies.runSsh(
    options,
    REMOTE_DELETE_SCRIPT,
    [remotePath, expectedHash],
    60_000,
    'sh',
    '删除本次创建的 Remote settings',
  );
  if (!/^deleted=1$/m.test(result)) fail('远端删除后复读结果无法确认。');
}

export async function applyPreparedEdits({ sshPath, prepared, saveRecovery, writeRemote }) {
  await saveRecovery(prepared.recovery);
  let localChanged = false;
  try {
    if (prepared.recovery.ssh.beforeHash !== prepared.recovery.ssh.afterHash) {
      await atomicLocalWrite({
        filePath: sshPath,
        expectedHash: prepared.recovery.ssh.beforeHash,
        text: prepared.sshText,
      });
      localChanged = true;
    }
    if (prepared.recovery.settings.owned) await writeRemote(prepared.settingsText, prepared.recovery.settings);
  } catch (error) {
    if (localChanged) {
      const current = await fs.readFile(sshPath, 'utf8');
      if (sha256(current) !== prepared.recovery.ssh.afterHash) {
        fail('配置失败且本地摘要已变化；保留恢复记录并停止覆盖。');
      }
      const restored = restoreEdits({
        sshText: current,
        settingsText: prepared.settingsText,
        recovery: prepared.recovery,
      }).sshText;
      await atomicLocalWrite({ filePath: sshPath, expectedHash: prepared.recovery.ssh.afterHash, text: restored });
    }
    throw error;
  }
}

export const markers = { begin: BEGIN_MARKER, end: END_MARKER };
