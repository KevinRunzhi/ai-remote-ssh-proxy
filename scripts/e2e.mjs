#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { applyEdits, modify, parseTree } from 'jsonc-parser';
import {
  ExpectedError,
  checkConfiguredEndpoint,
  inspectTarget,
  openSshExecutables,
  probeLocalProxy,
  probeRemoteTarget,
  remoteCommand,
  remoteListeners,
  remoteRead,
  runInteractiveProcess,
  runProcess,
  runScp,
  runSsh,
  sshBaseArgs,
  sshEffective,
} from './ssh.mjs';

const LOCAL_PROXY = 'http://127.0.0.1:7897';
const LOCAL_PORT = 7897;
const REMOTE_PORT = 17890;
const REMOTE_SETTINGS = '~/.vscode-server/data/Machine/settings.json';
const TARGET_URL = 'https://api.openai.com/v1/models';
const BEGIN_MARKER = '# BEGIN codex-proxy-e2e';
const END_MARKER = '# END codex-proxy-e2e';
const OPERATION_MARKER = '__CODEX_E2E_OPERATION_STARTED__';
const STATE_VERSION = 1;

function fail(message) {
  throw new ExpectedError(message);
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function parseArgs(argv) {
  const command = argv[0];
  if (!['rehearse', 'probe-auth', 'probe-transfer', 'inspect', 'configure', 'verify', 'observe', 'remove'].includes(command)) {
    fail('用法：node scripts/e2e.mjs <rehearse|probe-auth|probe-transfer|inspect|configure|verify|observe|remove> [--host alias] [--mode inherit|capture|cancel] [--ssh-config path] [--pid number] [--seconds number]');
  }

  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--host', '--mode', '--ssh-config', '--pid', '--seconds'].includes(key) || value === undefined) {
      fail(`无法识别的参数：${key ?? '(空)'}`);
    }
    if (values[key] !== undefined) fail(`参数重复：${key}`);
    values[key] = value;
  }

  const host = values['--host'];
  if (host && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(host)) fail('SSH Host alias 格式不合法。');
  if (!['rehearse', 'remove'].includes(command) && !host) fail(`${command} 需要 --host。`);
  const mode = values['--mode'];
  if (command === 'probe-auth' && !['inherit', 'capture', 'cancel'].includes(mode)) {
    fail('probe-auth 需要 --mode inherit|capture|cancel。');
  }
  if (command !== 'probe-auth' && mode !== undefined) fail('--mode 仅用于 probe-auth。');

  const pid = values['--pid'] === undefined ? null : Number(values['--pid']);
  if (pid !== null && (!Number.isInteger(pid) || pid < 1)) fail('--pid 必须是正整数。');
  const seconds = values['--seconds'] === undefined ? 60 : Number(values['--seconds']);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 300) fail('--seconds 必须是 5–300 的整数。');

  return {
    command,
    host,
    mode,
    pid,
    seconds,
    sshConfigExplicit: values['--ssh-config'] !== undefined,
    sshConfig: path.resolve(values['--ssh-config'] ?? path.join(os.homedir(), '.ssh', 'config')),
  };
}

const AUTH_PROBE_SCRIPT = String.raw`
set -eu
printf '${OPERATION_MARKER}\n'
printf '__CODEX_E2E_AUTH_OK__\n'
`;

async function probeAuth(options) {
  await assertRegularFile(options.sshConfig);
  const { ssh } = openSshExecutables();
  await assertRegularFile(ssh);
  const args = ['-T', ...sshBaseArgs(options), options.host, remoteCommand(AUTH_PROBE_SCRIPT)];
  const result = await runInteractiveProcess(ssh, args, {
    stdoutMode: options.mode === 'inherit' ? 'inherit' : 'pipe',
    stepLabel: `SSH 密码交互探针（${options.mode}）`,
    cancelProbe: options.mode === 'cancel',
  });

  if (options.mode === 'cancel') {
    if (result.timedOut) fail('取消探针超时，SSH 未结束。');
    if (result.stdout.includes(OPERATION_MARKER)) fail('取消前远端操作已开始，探针不通过。');
    if (result.exitCode === 0) fail('SSH 正常结束但缺少远端操作标记，结果不可信。');
    console.log('✅ 取消/认证失败边界通过：SSH 已结束，未进入远端操作。');
    return;
  }
  if (result.timedOut) fail('SSH 认证等待超时；未进入远端操作。');
  if (result.exitCode !== 0) fail(`SSH 交互探针失败（退出码 ${result.exitCode ?? '未知'}）。`);
  if (options.mode === 'capture') {
    if (!result.authenticated || !result.stdout.includes(OPERATION_MARKER) || !result.stdout.includes('__CODEX_E2E_AUTH_OK__')) {
      fail('捕获模式未解析到完整的就绪、操作和成功标记。');
    }
  }
  console.log(`✅ SSH 密码交互探针通过（${options.mode}，退出码 0）。`);
}

const VERIFY_TRANSFER_SCRIPT = String.raw`
set -eu
stage=$1
file=$2
expected=$3
expected_name=$4
case "$file" in "$stage"/*) ;; *) exit 47;; esac
[ "$(basename "$file")" = "$expected_name" ] || exit 47
chmod 600 "$file"
[ "$(stat -c '%a' "$stage")" = 700 ] || exit 48
[ "$(stat -c '%a' "$file")" = 600 ] || exit 48
actual=$(sha256sum "$file" | awk '{print $1}')
[ "$actual" = "$expected" ] || exit 48
printf '__CODEX_E2E__\nhash=%s\nmode=600\nspace=1\n' "$actual"
`;

async function probeTransfer(options) {
  await assertRegularFile(options.sshConfig);
  await assertRegularFile(openSshExecutables().scp);
  const sample = 'codex remote ssh proxy e2e transfer sample\n';
  const name = 'transfer sample.txt';
  let staging = null;
  try {
    staging = await uploadToStage(options, sample, name);
    const stdout = await runSsh(options, VERIFY_TRANSFER_SCRIPT, [
      staging.stage, staging.file, sha256(sample), name,
    ], 30_000, 'sh', '校验 SCP 样本摘要与权限');
    if (!stdout.includes(`hash=${sha256(sample)}`) || !/^mode=600$/m.test(stdout) || !/^space=1$/m.test(stdout)) {
      fail('SCP 样本校验结果不完整。');
    }
  } finally {
    if (staging) {
      try {
        await cleanupRemoteStage(options, staging);
      } catch {
        fail(`SCP 样本清理结果不明：${staging.stage}`);
      }
    }
  }
  console.log('✅ SCP 探针通过：默认协议传输、空格路径、摘要、0600/0700 权限与清理均已确认。');
}

async function assertRegularFile(filePath) {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`文件不存在：${filePath}`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`拒绝处理链接或非普通文件：${filePath}`);
  return stat;
}

async function atomicLocalWrite(filePath, expectedHash, text) {
  const stat = await assertRegularFile(filePath);
  const current = await fs.readFile(filePath, 'utf8');
  if (sha256(current) !== expectedHash) fail(`写入前摘要已变化，未修改：${filePath}`);

  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.codex-e2e-${process.pid}-${Date.now()}`);
  let handle;
  try {
    handle = await fs.open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, stat.mode);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filePath);
    const reread = await fs.readFile(filePath, 'utf8');
    if (sha256(reread) !== sha256(text)) fail(`替换后复读失败：${filePath}`);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function splitLines(text) {
  return text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
}

function prepareSshEdit(text, host, { allowOwnedMarker = false } = {}) {
  if (/^\s*(?:Include|Match)\b/im.test(text)) fail('SSH config 含 Include 或 Match，T0 停止。');

  const desired = `RemoteForward 127.0.0.1:${REMOTE_PORT} 127.0.0.1:${LOCAL_PORT}`;
  const beginCount = text.split(BEGIN_MARKER).length - 1;
  const endCount = text.split(END_MARKER).length - 1;
  if (beginCount !== endCount || beginCount > 1) fail('SSH config 中存在不完整或重复的工具标记。');
  if (beginCount === 1) {
    const markerPattern = new RegExp(`${escapeRegExp(BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp(END_MARKER)}`);
    const marked = text.match(markerPattern)?.[0] ?? '';
    if (!allowOwnedMarker || !marked.includes(desired)) fail('发现工具标记但没有可确认的本次恢复记录。');
    return { text, changed: false, owned: true, snippet: '' };
  }

  const lines = splitLines(text);
  const hostLines = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const body = lines[index].replace(/[\r\n]+$/, '');
    const match = body.match(/^\s*Host\s+([^#]+?)(?:\s+#.*)?$/i);
    if (match) {
      const aliases = match[1].trim().split(/\s+/);
      if (aliases.includes(host)) hostLines.push({ index, offset, aliases });
    }
    offset += lines[index].length;
  }
  if (hostLines.length !== 1 || hostLines[0].aliases.length !== 1) {
    fail('目标必须位于唯一、单 alias 的字面 Host 块。');
  }

  const start = hostLines[0].index;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*Host\s+/i.test(lines[index])) { end = index; break; }
  }
  const block = lines.slice(start + 1, end);
  let equivalent = false;
  for (const line of block) {
    const match = line.replace(/[\r\n]+$/, '').match(/^\s*RemoteForward\s+(\S+)\s+(\S+)(?:\s+#.*)?$/i);
    if (!match) continue;
    const [remote, local] = match.slice(1);
    if (remote === `127.0.0.1:${REMOTE_PORT}` && local === `127.0.0.1:${LOCAL_PORT}`) equivalent = true;
    else if (remote.replace(/^\[|\]$/g, '').endsWith(`:${REMOTE_PORT}`)) fail(`远端端口 ${REMOTE_PORT} 已有不同转发映射。`);
  }
  if (equivalent) return { text, changed: false, owned: false, snippet: '' };

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = block.map((line) => line.match(/^(\s+)\S/)?.[1]).find(Boolean) ?? '    ';
  const insertionOffset = lines.slice(0, end).reduce((sum, line) => sum + line.length, 0);
  const needsLeadingEol = insertionOffset > 0 && !/[\r\n]$/.test(text.slice(0, insertionOffset));
  const snippet = `${needsLeadingEol ? eol : ''}${indent}${BEGIN_MARKER}${eol}${indent}${desired}${eol}${indent}${END_MARKER}${eol}`;
  return {
    text: `${text.slice(0, insertionOffset)}${snippet}${text.slice(insertionOffset)}`,
    changed: true,
    owned: true,
    snippet,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function prepareSettingsEdit(originalText) {
  const existed = originalText !== null;
  const initial = originalText ?? '{}\n';
  const errors = [];
  const root = parseTree(initial, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || root?.type !== 'object') fail('Remote settings 不是可安全局部编辑的 JSONC 对象。');

  const properties = rootPropertyMap(root);
  for (const key of ['http.useLocalProxyConfiguration', 'http.proxy']) {
    if ((properties.get(key)?.length ?? 0) > 1) fail(`Remote settings 中 ${key} 重复，T0 停止。`);
  }
  const proxyNode = properties.get('http.proxy')?.[0];
  const useLocalNode = properties.get('http.useLocalProxyConfiguration')?.[0];
  if (proxyNode && proxyNode.value !== `http://127.0.0.1:${REMOTE_PORT}`) fail('Remote settings 已有不同的 http.proxy，未读取或保存其值。');
  if (useLocalNode && useLocalNode.value !== false) fail('Remote settings 已有不同的 http.useLocalProxyConfiguration。');

  let text = initial;
  const inverseSteps = [];
  for (const [key, value] of [
    ['http.useLocalProxyConfiguration', false],
    ['http.proxy', `http://127.0.0.1:${REMOTE_PORT}`],
  ]) {
    const currentRoot = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
    const currentNode = rootPropertyMap(currentRoot).get(key)?.[0];
    if (currentNode?.value === value) continue;
    const edits = modify(text, [key], value, { formattingOptions: formattingOptions(text) });
    if (edits.length !== 1) fail('当前 JSONC 布局超出 T0 可安全恢复范围。');
    const edit = edits[0];
    const next = applyEdits(text, edits);
    inverseSteps.push({ offset: edit.offset, length: edit.content.length, content: text.slice(edit.offset, edit.offset + edit.length) });
    text = next;
  }
  return { text, changed: text !== initial, existed, inverseSteps };
}

function undoSettings(text, inverseSteps) {
  let restored = text;
  for (const inverse of [...inverseSteps].reverse()) restored = applyEdits(restored, [inverse]);
  return restored;
}

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
if [ "$current" != "$expected" ]; then exit 42; fi
case "$uploaded" in "$stage"/*) ;; *) exit 47;; esac
[ -f "$uploaded" ] && [ ! -L "$uploaded" ] || exit 47
[ "$(sha256sum "$uploaded" | awk '{print $1}')" = "$uploaded_hash" ] || exit 48
directory=$(dirname "$file")
if [ ! -d "$directory" ]; then exit 43; fi
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
if [ -L "$file" ] || [ ! -f "$file" ]; then exit 41; fi
current=$(sha256sum "$file" | awk '{print $1}')
if [ "$current" != "$expected" ]; then exit 42; fi
rm -- "$file"
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
printf '__CODEX_E2E__\nstage=%s\nfile=%s\n' "$(printf '%s' "$stage" | base64 | tr -d '\n')" "$(printf '%s' "$stage/$name" | base64 | tr -d '\n')"
`;

const CLEAN_STAGE_SCRIPT = String.raw`
set -eu
stage=$1
file=$2
case "$file" in "$stage"/*) ;; *) exit 47;; esac
rm -f -- "$file"
rmdir -- "$stage"
printf '__CODEX_E2E__\nclean=1\n'
`;

function parseStage(stdout) {
  const marker = stdout.lastIndexOf('__CODEX_E2E__\n');
  const body = marker < 0 ? '' : stdout.slice(marker + '__CODEX_E2E__\n'.length);
  const stage = Buffer.from(body.match(/^stage=([^\n]+)$/m)?.[1] ?? '', 'base64').toString('utf8');
  const file = Buffer.from(body.match(/^file=([^\n]+)$/m)?.[1] ?? '', 'base64').toString('utf8');
  if (!/^\/[A-Za-z0-9._/ -]+$/.test(stage) || !/^\/[A-Za-z0-9._/ -]+$/.test(file) || !file.startsWith(`${stage}/`)) {
    fail('远端暂存路径无法安全识别。');
  }
  return { stage, file };
}

async function createRemoteStage(options, name) {
  const token = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  return parseStage(await runSsh(options, CREATE_STAGE_SCRIPT, [token, name], 30_000, 'sh', '创建远端私有暂存目录'));
}

async function cleanupRemoteStage(options, staging) {
  const stdout = await runSsh(options, CLEAN_STAGE_SCRIPT, [staging.stage, staging.file], 30_000, 'sh', '清理远端暂存目录');
  if (!/^clean=1$/m.test(stdout)) fail('远端暂存清理结果无法确认。');
}

async function createRestrictedTempFile(text) {
  const { directory } = await secureStateDirectory();
  const file = path.join(directory, `upload-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(file, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return file;
}

async function uploadToStage(options, text, name = 'settings upload.json', onStage = async () => {}) {
  const localFile = await createRestrictedTempFile(text);
  let staging = null;
  try {
    staging = await createRemoteStage(options, name);
    await onStage(staging);
    await runScp(options, localFile, staging.file, '上传远端暂存文件');
    return staging;
  } catch (error) {
    if (staging) {
      try {
        await cleanupRemoteStage(options, staging);
        await onStage(null);
      } catch {
        fail(`暂存清理结果不明；请保留恢复记录并核对：${staging.stage}`);
      }
    }
    throw error;
  } finally {
    await fs.rm(localFile, { force: true }).catch(() => {});
  }
}

async function remoteWrite(options, expectedHash, text, mode = '600', onStage = async () => {}) {
  const expectedUploadHash = sha256(text);
  const staging = await uploadToStage(options, text, 'settings upload.json', onStage);
  try {
    const stdout = await runSsh(options, REMOTE_WRITE_SCRIPT, [
      REMOTE_SETTINGS, expectedHash, mode, staging.stage, staging.file, expectedUploadHash,
    ], 60_000, 'sh', '写入 Remote settings');
    const resultingHash = stdout.trim().split(/\s+/).at(-1);
    if (resultingHash !== expectedUploadHash) fail('远端替换后复读摘要不匹配。');
  } finally {
    try {
      await cleanupRemoteStage(options, staging);
      await onStage(null);
    } catch {
      fail(`Remote settings 结果需要核对，且暂存清理结果不明：${staging.stage}`);
    }
  }
}

async function remoteDelete(options, expectedHash) {
  await runSsh(options, REMOTE_DELETE_SCRIPT, [REMOTE_SETTINGS, expectedHash], 60_000, 'sh', '删除本次创建的 Remote settings');
}

function assertOnlyForwardChanged(before, after) {
  const clean = (text) => text.split('\n').filter((line) => !line.startsWith('remoteforward ')).join('\n');
  if (clean(before) !== clean(after)) fail('ssh -G 显示除 RemoteForward 外还有有效配置变化。');
  const forward = after.split('\n').find((line) => line.startsWith('remoteforward ') && line.includes(String(REMOTE_PORT)) && line.includes(String(LOCAL_PORT)));
  if (!forward) fail('ssh -G 未确认预期的 RemoteForward。');
}

async function confirm(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('当前不是交互终端，未进行任何修改。');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} 输入 yes 继续：`)).trim().toLowerCase();
    return answer === 'yes';
  } finally {
    rl.close();
  }
}

function statePaths() {
  if (!process.env.LOCALAPPDATA) fail('LOCALAPPDATA 不存在，无法保存恢复信息。');
  const directory = path.join(process.env.LOCALAPPDATA, 'codex-remote-ssh-proxy-e2e');
  return { directory, file: path.join(directory, 'active.json') };
}

async function secureStateDirectory() {
  if (process.platform !== 'win32') fail('T0 仅支持 Windows 本地。');
  const { directory } = statePaths();
  await fs.mkdir(directory, { recursive: true });
  const identity = await runProcess({ executable: 'whoami.exe', args: ['/user', '/fo', 'csv', '/nh'] });
  const sid = identity.stdout.match(/"(S-1-[0-9-]+)"/)?.[1];
  if (identity.exitCode !== 0 || !sid) fail('无法取得当前用户 SID，未保存恢复信息。');
  const acl = await runProcess({ executable: 'icacls.exe', args: [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`] });
  if (acl.exitCode !== 0) fail('无法把恢复目录限制为当前用户，未修改配置。');
  return statePaths();
}

async function readState(required = true) {
  const { file } = statePaths();
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) fail('恢复记录不是普通文件。');
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    if (state.version !== STATE_VERSION) fail('恢复记录版本不受支持。');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT' && !required) return null;
    if (error.code === 'ENOENT') fail('没有本次配置记录。');
    if (error instanceof SyntaxError) fail('恢复记录损坏，停止操作。');
    throw error;
  }
}

async function createState(state) {
  const { file } = await secureStateDirectory();
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    if (error.code === 'EEXIST') fail('已有未移除的目标记录；请先核对并 remove。');
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function replaceState(state) {
  const { file } = statePaths();
  const current = await fs.readFile(file, 'utf8');
  await atomicLocalWrite(file, sha256(current), `${JSON.stringify(state, null, 2)}\n`);
}

function assertNoPendingStaging(state) {
  if (state.remoteStaging) {
    fail(`上次远端暂存清理结果不明；请先人工核对：${state.remoteStaging}`);
  }
}

function trackStateStaging(state) {
  return async (staging) => {
    state.remoteStaging = staging?.stage ?? null;
    await replaceState(state);
  };
}

async function deleteState() {
  await fs.unlink(statePaths().file);
}

function assertStateMatchesOptions(state, options) {
  if (options.host && state.host !== options.host) fail('Host 与本次恢复记录不符。');
  if (path.resolve(state.sshConfig) !== options.sshConfig) fail('SSH config 路径与本次恢复记录不符。');
}

function recordedOptions(state, options) {
  return {
    ...options,
    host: options.host ?? state.host,
    sshConfig: options.sshConfigExplicit ? options.sshConfig : path.resolve(state.sshConfig),
  };
}

async function inspectAppliedState(state, options) {
  assertNoPendingStaging(state);
  const localText = await fs.readFile(state.sshConfig, 'utf8');
  const remote = await remoteRead({ ...options, host: state.host, sshConfig: state.sshConfig });
  if (sha256(localText) !== state.localAfterHash || remote.hash !== state.remoteAfterHash) {
    fail('配置与本次记录摘要不符；停止覆盖并保留恢复信息。');
  }
  return { localText, remote };
}

async function configure(options) {
  await probeLocalProxy({ localProxy: LOCAL_PROXY, localPort: LOCAL_PORT, targetUrl: TARGET_URL });
  const existingState = await readState(false);
  if (existingState) {
    assertNoPendingStaging(existingState);
    const effectiveOptions = recordedOptions(existingState, options);
    assertStateMatchesOptions(existingState, effectiveOptions);
    await assertRegularFile(effectiveOptions.sshConfig);
    const preflight = await preflightRemote(effectiveOptions);
    await inspectAppliedState(existingState, effectiveOptions);
    const endpoint = await checkConfiguredEndpoint(effectiveOptions, preflight.listenerTool, REMOTE_PORT);
    console.log(`${endpoint.status === 'pass' ? '✅' : 'ℹ️'} ${endpoint.message}`);
    return;
  }

  await assertRegularFile(options.sshConfig);

  const localOriginal = await fs.readFile(options.sshConfig, 'utf8');
  const sshEdit = prepareSshEdit(localOriginal, options.host);
  const effectiveBefore = await sshEffective(options);
  const preflight = await preflightRemote(options);
  const listeners = await remoteListeners(options, preflight.listenerTool);
  if (sshEdit.changed && listeners.length) fail(`首次新增要求远端端口 ${REMOTE_PORT} 空闲。`);
  const remoteOriginal = await remoteRead(options);
  const settingsEdit = prepareSettingsEdit(remoteOriginal.text);

  console.log('\n即将配置固定 T0 样本：');
  console.log(`- 目标：${options.host}`);
  console.log(`- SSH config：仅在目标 Host 块${sshEdit.changed ? '新增一段带标记的 RemoteForward' : '复用等价转发'}`);
  console.log(`- 转发：127.0.0.1:${REMOTE_PORT} → 127.0.0.1:${LOCAL_PORT}`);
  console.log(`- Remote settings：${settingsEdit.changed ? '局部设置两个代理字段' : '复用两个等价字段'}`);
  console.log('- 影响：该远端用户的其他 VS Code 扩展也可能读取这些代理设置。');
  console.log(`- 恢复记录：${statePaths().directory}`);
  if (!(await confirm('确认以上增量吗？'))) {
    console.log('已取消，没有修改。');
    return;
  }

  const state = {
    version: STATE_VERSION,
    host: options.host,
    sshConfig: options.sshConfig,
    remoteSettings: REMOTE_SETTINGS,
    localProxy: LOCAL_PROXY,
    remotePort: REMOTE_PORT,
    localOwned: sshEdit.owned && sshEdit.changed,
    localSnippet: sshEdit.snippet,
    localBeforeHash: sha256(localOriginal),
    localAfterHash: sha256(sshEdit.text),
    remoteOwned: settingsEdit.changed,
    remoteExisted: remoteOriginal.exists,
    remoteMode: remoteOriginal.mode,
    remoteBeforeHash: remoteOriginal.hash,
    remoteAfterHash: sha256(settingsEdit.text),
    remoteInverseSteps: settingsEdit.inverseSteps,
    listenerTool: preflight.listenerTool,
    remoteStaging: null,
  };
  await createState(state);

  try {
    if (sshEdit.changed) {
      await atomicLocalWrite(options.sshConfig, state.localBeforeHash, sshEdit.text);
      const effectiveAfter = await sshEffective(options);
      assertOnlyForwardChanged(effectiveBefore, effectiveAfter);
    }
    if (settingsEdit.changed) {
      await remoteWrite(
        options,
        state.remoteBeforeHash,
        settingsEdit.text,
        remoteOriginal.exists ? remoteOriginal.mode : '600',
        trackStateStaging(state),
      );
    }
    await inspectAppliedState(state, options);
  } catch (error) {
    const restored = await rollbackConfigure(state, options).catch(() => false);
    if (restored) await deleteState().catch(() => {});
    if (!restored) fail('配置中断且无法确认完整恢复；已保留恢复记录，请勿继续覆盖。');
    throw error;
  }

  console.log('✅ 配置已写入并复读；现在仍不能声明 Codex 可用。');
  console.log(`下一步：保存工作，关闭目标远端窗口，用同一 alias（${options.host}）重连并重新打开 Codex。`);
}

async function rollbackConfigure(state, options) {
  assertNoPendingStaging(state);
  const remote = await remoteRead(options);
  if (state.remoteOwned && remote.hash === state.remoteAfterHash) {
    if (state.remoteExisted) {
      const restored = undoSettings(remote.text, state.remoteInverseSteps);
      if (sha256(restored) !== state.remoteBeforeHash) return false;
      await remoteWrite(options, state.remoteAfterHash, restored, state.remoteMode, trackStateStaging(state));
    } else {
      await remoteDelete(options, state.remoteAfterHash);
    }
  } else if (remote.hash !== state.remoteBeforeHash) return false;

  const local = await fs.readFile(state.sshConfig, 'utf8');
  const localHash = sha256(local);
  if (state.localOwned && localHash === state.localAfterHash) {
    const restored = removeOwnedSnippet(local, state.localSnippet);
    if (sha256(restored) !== state.localBeforeHash) return false;
    await atomicLocalWrite(state.sshConfig, state.localAfterHash, restored);
  } else if (localHash !== state.localBeforeHash) return false;
  return true;
}

function removeOwnedSnippet(text, snippet) {
  if (!snippet || text.split(snippet).length !== 2) fail('SSH 工具片段无法唯一定位。');
  return text.replace(snippet, '');
}

const PROCESS_SCRIPT = String.raw`
set -eu
port=$1
requested=$2
needle=$3
pids=
for file in /proc/[0-9]*/cmdline; do
  [ -r "$file" ] || continue
  pid=$(printf '%s' "$file" | awk -F/ '{print $3}')
  [ "$pid" = "$$" ] && continue
  if tr '\000' '\n' < "$file" 2>/dev/null | grep -qxF -- "$needle"; then pids="$pids $pid"; fi
done
set -- $pids
if [ "$requested" != "auto" ]; then
  selected=
  for pid do [ "$pid" = "$requested" ] && selected=$pid; done
  [ -n "$selected" ] || { printf '__CODEX_E2E__\nselection=missing\n'; exit 46; }
elif [ "$#" -eq 0 ]; then printf '__CODEX_E2E__\nselection=none\n'; exit 46
elif [ "$#" -eq 1 ]; then selected=$1
else printf '__CODEX_E2E__\nselection=ambiguous\ncount=%s\n' "$#"; exit 46
fi
expected="http://127.0.0.1:$port"
http=missing; https=missing; lower=ok; bypass=ok
while IFS='=' read -r key value; do
  case "$key" in
    HTTP_PROXY) [ "$value" = "$expected" ] && http=match || http=conflict;;
    HTTPS_PROXY) [ "$value" = "$expected" ] && https=match || https=conflict;;
    http_proxy|https_proxy) [ "$value" = "$expected" ] || lower=conflict;;
    NO_PROXY|no_proxy)
      lowered=$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')
      case "$lowered" in '*'|*openai.com*) bypass=conflict;; esac;;
  esac
done < <(tr '\000' '\n' < "/proc/$selected/environ")
printf '__CODEX_E2E__\npid=%s\nHTTP_PROXY=%s\nHTTPS_PROXY=%s\nlowercase=%s\nbypass=%s\n' "$selected" "$http" "$https" "$lower" "$bypass"
`;

function parseProcessCheck(stdout) {
  const marker = stdout.lastIndexOf('__CODEX_E2E__\n');
  const body = marker >= 0 ? stdout.slice(marker + '__CODEX_E2E__\n'.length) : '';
  if (/^selection=none$/m.test(body)) fail('未找到真实 Codex app-server 进程；请在远端窗口打开 Codex 后重试。');
  if (/^selection=missing$/m.test(body)) fail('--pid 指定的进程不是当前 Codex app-server。');
  const count = body.match(/^selection=ambiguous\ncount=(\d+)$/m)?.[1];
  if (count) fail('找到 ' + count + ' 个 Codex app-server 候选；请用 --pid 指定已确认的 PID。');

  const pid = body.match(/^pid=(\d+)$/m)?.[1];
  const statuses = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'lowercase', 'bypass'].map((key) => [
    key,
    body.match(new RegExp('^' + key + '=(match|ok|missing|conflict)$', 'm'))?.[1] ?? 'unknown',
  ]));
  if (!pid) fail('Codex 后端进程检查返回无法识别的脱敏结果。');
  if (statuses.HTTP_PROXY !== 'match' || statuses.HTTPS_PROXY !== 'match' || statuses.lowercase !== 'ok' || statuses.bypass !== 'ok') {
    fail(
      'Codex 后端代理环境不匹配：'
      + 'HTTP_PROXY=' + statuses.HTTP_PROXY
      + '，HTTPS_PROXY=' + statuses.HTTPS_PROXY
      + '，lowercase=' + statuses.lowercase
      + '，bypass=' + statuses.bypass + '。',
    );
  }
  return pid;
}

async function verify(options) {
  const state = await readState();
  assertNoPendingStaging(state);
  options = recordedOptions(state, options);
  assertStateMatchesOptions(state, options);
  await probeLocalProxy({ localProxy: LOCAL_PROXY, localPort: LOCAL_PORT, targetUrl: TARGET_URL });
  const preflight = await preflightRemote(options);
  await inspectAppliedState(state, options);
  const listeners = await remoteListeners(options, preflight.listenerTool);
  if (listeners.length !== 1) fail(`远端 127.0.0.1:${REMOTE_PORT} 尚未监听；请先重连。`);
  console.log('✅ 远端入口：仅检测到预期 IPv4 回环监听。');

  const network = await probeRemoteTarget(options, REMOTE_PORT);
  if (!network.ok) fail(`远端目标 HTTPS 检查失败：${network.message}`);
  console.log('✅ 目标 HTTPS：CONNECT 200、TLS 有效、目标返回预期 401。');

  const processOutput = await runSsh(
    options,
    PROCESS_SCRIPT,
    [String(REMOTE_PORT), String(options.pid ?? 'auto'), 'app-server'],
    60_000,
    'bash',
    '检查 Codex 后端进程环境',
    [46],
  );
  const pid = parseProcessCheck(processOutput);
  console.log(`✅ Codex 进程：PID ${pid} 的代理字段匹配，无冲突绕过。`);
  console.log(`主动网络探测已结束。接下来运行 observe --pid ${pid}，再由用户发送新请求。`);
}

const OBSERVE_SCRIPT = String.raw`
set -eu
port=$1
pid=$2
seconds=$3
tool=$4
port_hex=$5
[ -r "/proc/$pid/cmdline" ] || exit 46
end=$(( $(date +%s) + seconds ))
first_seen=
last_seen=
samples=0
while [ "$(date +%s)" -lt "$end" ]; do
  seen=0
  case "$tool" in
    ss) ss -ntpH 2>/dev/null | grep -F "127.0.0.1:$port" | grep -E "pid=$pid([,)])" >/dev/null && seen=1;;
    netstat) netstat -ntp 2>/dev/null | grep -F "127.0.0.1:$port" | grep -E "[[:space:]]$pid/" >/dev/null && seen=1;;
    proc)
      for descriptor in "/proc/$pid/fd"/*; do
        link=$(readlink "$descriptor" 2>/dev/null || true)
        case "$link" in socket:\[*\]) inode=$(printf '%s' "$link" | tr -cd '0-9');; *) continue;; esac
        if awk -v remote="0100007F:$port_hex" -v inode="$inode" '$3 == remote && $10 == inode { found=1 } END { exit !found }' /proc/net/tcp; then
          seen=1
          break
        fi
      done
      ;;
    *) exit 44;;
  esac
  if [ "$seen" -eq 1 ]; then
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    [ -n "$first_seen" ] || first_seen=$now
    last_seen=$now
    samples=$((samples + 1))
  fi
  sleep 0.5
done
if [ "$samples" -gt 0 ]; then
  printf '__CODEX_E2E__\nseen=1\nfirst=%s\nlast=%s\nsamples=%s\n' "$first_seen" "$last_seen" "$samples"
else
  printf '__CODEX_E2E__\nseen=0\n'
fi
`;

async function observe(options) {
  if (!options.pid) fail('observe 必须使用 verify 确认后的 --pid。');
  const state = await readState();
  assertNoPendingStaging(state);
  if (!['ss', 'netstat', 'proc'].includes(state.listenerTool)) fail('恢复记录缺少已确认的监听工具。');
  options = recordedOptions(state, options);
  assertStateMatchesOptions(state, options);
  console.log(`将持续观察 ${options.seconds} 秒；输入 SSH 密码并看到“认证成功”后，立即在对应 Codex 窗口发送一条新请求。脚本不会因已有连接提前结束。`);
  const stdout = await runSsh(
    options,
    OBSERVE_SCRIPT,
    [
      String(REMOTE_PORT),
      String(options.pid),
      String(options.seconds),
      state.listenerTool,
      REMOTE_PORT.toString(16).padStart(4, '0').toUpperCase(),
    ],
    (options.seconds + 60) * 1000,
    'sh',
    '观察 Codex 请求连接',
  );
  const body = stdout.slice(stdout.lastIndexOf('__CODEX_E2E__\n') + '__CODEX_E2E__\n'.length);
  if (!/^seen=1$/m.test(body)) fail('未观察到目标 PID 与远端代理端口的关联连接；不能证明请求路径。');
  const first = body.match(/^first=(.+)$/m)?.[1] ?? '未知';
  const last = body.match(/^last=(.+)$/m)?.[1] ?? '未知';
  const samples = body.match(/^samples=(\d+)$/m)?.[1] ?? '0';
  console.log(`✅ 完整观察窗口内，目标 PID 到 127.0.0.1:${REMOTE_PORT} 的连接共命中 ${samples} 次（${first} 至 ${last}）。`);
  console.log('请另行确认：新请求在该观察窗口内发送，且已收到新回复。');
}

async function remove(options) {
  const state = await readState();
  assertNoPendingStaging(state);
  const effectiveOptions = recordedOptions(state, options);
  assertStateMatchesOptions(state, effectiveOptions);
  const localText = await fs.readFile(state.sshConfig, 'utf8');
  const localHash = sha256(localText);
  const remote = await remoteRead(effectiveOptions);
  const localKnown = [state.localBeforeHash, state.localAfterHash].includes(localHash);
  const remoteKnown = [state.remoteBeforeHash, state.remoteAfterHash].includes(remote.hash);
  if (!localKnown || !remoteKnown) fail('当前配置摘要与修改前后状态都不符；停止移除并保留用户修改。');

  console.log('\n即将移除本次拥有的配置：');
  console.log(`- Remote settings：${state.remoteOwned ? '恢复本次两个字段编辑' : '保留用户等价设置'}`);
  console.log(`- SSH config：${state.localOwned ? '移除本次标记片段' : '保留用户等价转发'}`);
  if (!(await confirm('确认移除吗？'))) {
    console.log('已取消，没有修改。');
    return;
  }

  if (state.remoteOwned && remote.hash === state.remoteAfterHash) {
    if (state.remoteExisted) {
      const restored = undoSettings(remote.text, state.remoteInverseSteps);
      if (sha256(restored) !== state.remoteBeforeHash) fail('远端设置无法按记录精确恢复。');
      await remoteWrite(effectiveOptions, state.remoteAfterHash, restored, state.remoteMode, trackStateStaging(state));
    } else {
      await remoteDelete(effectiveOptions, state.remoteAfterHash);
    }
  }

  if (state.localOwned && localHash === state.localAfterHash) {
    const restored = removeOwnedSnippet(localText, state.localSnippet);
    if (sha256(restored) !== state.localBeforeHash) fail('SSH config 无法按记录精确恢复。');
    await atomicLocalWrite(state.sshConfig, state.localAfterHash, restored);
  }

  const finalLocal = await fs.readFile(state.sshConfig, 'utf8');
  const finalRemote = await remoteRead(effectiveOptions);
  if (sha256(finalLocal) !== state.localBeforeHash || finalRemote.hash !== state.remoteBeforeHash) fail('移除后复读未回到修改前摘要；恢复记录已保留。');
  await deleteState();
  console.log('✅ 本次拥有的配置已恢复并复读，恢复记录已删除。请重连 VS Code Remote SSH 后复查。');
}

async function rehearse() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-proxy-e2e-'));
  const sshPath = path.join(directory, 'config');
  const settingsPath = path.join(directory, 'settings.json');
  const sshOriginal = 'Host t0-sample\r\n    HostName example.invalid\r\n';
  const settingsOriginal = '{\n  // 保留注释\n  "editor.tabSize": 2\n}\n';
  try {
    assert.throws(
      () => parseProcessCheck('__CODEX_E2E__\nselection=none\n'),
      (error) => error instanceof ExpectedError && error.message.includes('未找到真实 Codex app-server'),
    );
    assert.equal(
      parseProcessCheck('__CODEX_E2E__\npid=123\nHTTP_PROXY=match\nHTTPS_PROXY=match\nlowercase=ok\nbypass=ok\n'),
      '123',
    );
    await fs.writeFile(sshPath, sshOriginal, { mode: 0o600 });
    await fs.writeFile(settingsPath, settingsOriginal, { mode: 0o600 });
    const sshEdit = prepareSshEdit(sshOriginal, 't0-sample');
    const settingsEdit = prepareSettingsEdit(settingsOriginal);
    const missingSettingsEdit = prepareSettingsEdit(null);
    const equivalentSsh = prepareSshEdit(
      'Host t0-sample\n    RemoteForward 127.0.0.1:17890 127.0.0.1:7897\n',
      't0-sample',
    );
    assert.match(sshEdit.text, /127\.0\.0\.1:17890 127\.0\.0\.1:7897/);
    assert.match(settingsEdit.text, /\/\/ 保留注释/);
    assert.equal(missingSettingsEdit.existed, false);
    assert.equal(equivalentSsh.changed, false);
    assert.equal(equivalentSsh.owned, false);
    assert.equal(prepareSshEdit(sshEdit.text, 't0-sample', { allowOwnedMarker: true }).changed, false);
    assert.equal(prepareSettingsEdit(settingsEdit.text).changed, false);

    await atomicLocalWrite(sshPath, sha256(sshOriginal), sshEdit.text);
    await atomicLocalWrite(settingsPath, sha256(settingsOriginal), settingsEdit.text);
    await fs.appendFile(sshPath, '# 用户后续修改\r\n');
    await assert.rejects(() => atomicLocalWrite(sshPath, sha256(sshEdit.text), sshOriginal), ExpectedError);

    await fs.writeFile(sshPath, sshEdit.text, { mode: 0o600 });
    const restoredSsh = removeOwnedSnippet(sshEdit.text, sshEdit.snippet);
    const restoredSettings = undoSettings(settingsEdit.text, settingsEdit.inverseSteps);
    assert.equal(restoredSsh, sshOriginal);
    assert.equal(restoredSettings, settingsOriginal);
    await atomicLocalWrite(sshPath, sha256(sshEdit.text), restoredSsh);
    await atomicLocalWrite(settingsPath, sha256(settingsEdit.text), restoredSettings);
    assert.equal(await fs.readFile(sshPath, 'utf8'), sshOriginal);
    assert.equal(await fs.readFile(settingsPath, 'utf8'), settingsOriginal);
    console.log('✅ 临时演练通过：注释保留、端口不同、重复无增量、摘要变化拒绝覆盖、正常撤销。');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function inspect(options) {
  const result = await inspectTarget({
    ...options,
    localProxy: LOCAL_PROXY,
    localPort: LOCAL_PORT,
    remotePort: REMOTE_PORT,
    remoteSettings: REMOTE_SETTINGS,
    targetUrl: TARGET_URL,
  });
  const icons = { pass: '✅', fail: '❌', unknown: 'ℹ️' };
  for (const check of result.checks) console.log(`${icons[check.status]} ${check.layer}：${check.message}`);
  if (!result.ok) process.exitCode = 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'rehearse') return rehearse();
  if (options.command === 'probe-auth') return probeAuth(options);
  if (options.command === 'probe-transfer') return probeTransfer(options);
  if (options.command === 'inspect') return inspect(options);
  if (options.command === 'configure') return configure(options);
  if (options.command === 'verify') return verify(options);
  if (options.command === 'observe') return observe(options);
  return remove(options);
}

main().catch((error) => {
  if (error instanceof ExpectedError) console.error(`❌ ${error.message}`);
  else console.error('❌ 未预期错误；未展示可能含敏感信息的原始内容。');
  process.exitCode = 1;
});
