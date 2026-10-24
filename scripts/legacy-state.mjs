import { ExpectedError } from './ssh.mjs';
import { alias, configPath, normalizeProxy, port } from './input.mjs';

function fail() { throw new ExpectedError('旧记录不符合已核对的迁移格式；保留原件，停止迁移。'); }
function hash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function linuxPath(value) { return typeof value === 'string' && value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value); }

// 仅转换旧代码实际写出的字段；不复制未知值、配置正文或凭证。
export function legacyContents(value) {
  if (!value || ![1, 2].includes(value.version)) fail();
  const local = normalizeProxy(value.localProxy), remotePort = port(value.remotePort);
  if (value.localPort !== undefined && value.localPort !== local.localPort) fail();
  const sshConfig = configPath(value.sshConfig), host = alias(value.host);
  if (!linuxPath(value.remoteSettings) || !/^[0-7]{3,4}$/.test(value.remoteMode)
      || !['ss', 'netstat', 'proc'].includes(value.listenerTool)) fail();
  const recovery = value.version === 2 ? value.recovery : {
    ssh: { owned: value.localOwned, snippet: value.localSnippet, beforeHash: value.localBeforeHash, afterHash: value.localAfterHash },
    settings: { owned: value.remoteOwned, existed: value.remoteExisted, inverseSteps: value.remoteInverseSteps,
      properties: {}, beforeHash: value.remoteBeforeHash, afterHash: value.remoteAfterHash },
  };
  const ssh = recovery?.ssh, settings = recovery?.settings;
  if (!ssh || !settings || typeof ssh.owned !== 'boolean' || typeof settings.owned !== 'boolean'
      || typeof settings.existed !== 'boolean' || !hash(ssh.beforeHash) || !hash(ssh.afterHash)
      || !hash(settings.afterHash) || !(settings.existed ? hash(settings.beforeHash) : settings.beforeHash === 'missing')) fail();
  if (typeof ssh.snippet !== 'string') fail();
  if (ssh.owned) {
    const lines = ssh.snippet.replace(/^\r?\n/, '').trim().split(/\r?\n/).map((line) => line.trim());
    if (lines.length !== 3 || lines[0] !== '# BEGIN codex-proxy-e2e'
        || lines[1] !== `RemoteForward 127.0.0.1:${remotePort} 127.0.0.1:${local.localPort}`
        || lines[2] !== '# END codex-proxy-e2e') fail();
  } else if (ssh.snippet !== '' || ssh.beforeHash !== ssh.afterHash) fail();
  if (!Array.isArray(settings.inverseSteps) || settings.inverseSteps.length > 2
      || settings.inverseSteps.some((step) => !step || !Number.isSafeInteger(step.offset) || step.offset < 0
        || !Number.isSafeInteger(step.length) || step.length <= 0 || step.offset + step.length > 1024 * 1024 || step.content !== '')) fail();
  if (!settings.owned && (settings.inverseSteps.length || settings.beforeHash !== settings.afterHash)) fail();
  const properties = {};
  for (const [key, entry] of Object.entries(settings.properties ?? {})) {
    if (!['http.useLocalProxyConfiguration', 'http.proxy'].includes(key) || typeof entry?.owned !== 'boolean'
        || entry.original !== (entry.owned ? 'missing' : 'equivalent')) fail();
    properties[key] = { owned: entry.owned, original: entry.original };
  }
  const phase = value.version === 1 ? 'applied' : value.phase;
  if (!['prepared', 'local-written', 'remote-written', 'applied'].includes(phase)) fail();
  const remoteStaging = value.remoteStaging ?? null;
  if (remoteStaging !== null && !linuxPath(remoteStaging)) fail();
  return { connection: { alias: host, sshConfig, hostname: null, username: null, sshPort: null, identity: 'unknown' },
    parameters: { localProxy: local.localProxy, remotePort }, phase, remoteStaging, remoteSettings: value.remoteSettings, remoteMode: value.remoteMode,
    listenerTool: value.listenerTool, recovery: {
      ssh: { owned: ssh.owned, existed: true, snippet: ssh.snippet, beforeHash: ssh.beforeHash, afterHash: ssh.afterHash },
      settings: { owned: settings.owned, existed: settings.existed, properties, inverseSteps: settings.inverseSteps.map(({ offset, length }) => ({ offset, length, content: '' })),
        beforeHash: settings.beforeHash, afterHash: settings.afterHash },
    } };
}
