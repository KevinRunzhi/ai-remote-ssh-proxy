import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { applyEdits as applyJsoncEdits, modify, parseTree } from 'jsonc-parser';

const BEGIN_MARKER = '# BEGIN codex-proxy-e2e';
const END_MARKER = '# END codex-proxy-e2e';
const SETTINGS = ['http.useLocalProxyConfiguration', 'http.proxy'];

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
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || root?.type !== 'object') fail('Remote settings 不是可安全局部编辑的 JSONC 对象。');
  const properties = rootPropertyMap(root);
  for (const key of SETTINGS) {
    if ((properties.get(key)?.length ?? 0) > 1) fail(`Remote settings 中 ${key} 重复，停止修改。`);
  }
  return properties;
}

function insertionInverse(before, after) {
  let prefix = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  if (prefix + suffix !== before.length) fail('JSONC 编辑不是纯插入，无法保存最小恢复信息。');
  return { offset: prefix, length: after.length - before.length, content: '' };
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
    const edits = modify(text, [key], value, { formattingOptions: formattingOptions(text) });
    if (edits.length !== 1) fail('当前 JSONC 布局超出可安全恢复范围。');
    const next = applyJsoncEdits(text, edits);
    inverseSteps.push(insertionInverse(text, next));
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

export function restoreEdits({ sshText, settingsText, recovery }) {
  if (sha256(sshText) !== recovery.ssh.afterHash || sha256(settingsText) !== recovery.settings.afterHash) {
    fail('当前配置摘要与应用后状态不符；停止恢复以保留用户修改。');
  }
  let restoredSsh = sshText;
  if (recovery.ssh.owned) {
    const snippet = recovery.ssh.snippet;
    if (!snippet || restoredSsh.split(snippet).length !== 2) fail('SSH 工具片段无法唯一定位。');
    restoredSsh = restoredSsh.replace(snippet, '');
  }
  const restoredSettings = undoSettings(settingsText, recovery.settings.inverseSteps);
  if (sha256(restoredSsh) !== recovery.ssh.beforeHash) fail('SSH config 无法按记录精确恢复。');
  if (recovery.settings.existed && sha256(restoredSettings) !== recovery.settings.beforeHash) {
    fail('Remote settings 无法按记录精确恢复。');
  }
  return { sshText: restoredSsh, settingsText: recovery.settings.existed ? restoredSettings : null };
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
