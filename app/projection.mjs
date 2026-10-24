const choices = new Set(['confirm', 'cancel', 'ready', 'later', 'cleanup', 'retain', 'remove-connection', 'retain-connection', 'new-reply']);
const outcomes = new Set(['succeeded', 'needs-user', 'failed', 'cancelled', 'recovery-required']);
const layers = new Set(['local-proxy', 'ssh', 'remote-endpoint', 'target-https', 'codex-process']);
const stages = new Set(['state', 'local-preflight', 'remote-preflight', 'reconcile', 'connection', 'forwarding', 'server', 'settings', 'codex', 'verify', 'remove', 'abandon']);
const safeString = (value, max = 8192) => typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ? value : null;
const strings = (value) => Array.isArray(value) && value.length <= 20 ? value.map((item) => safeString(item)).filter((item) => item !== null) : [];
function selected(value, fields) {
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(fields.filter((key) => typeof value[key] === 'string' || Number.isSafeInteger(value[key]) || value[key] === null)
    .map((key) => [key, typeof value[key] === 'string' ? safeString(value[key]) : value[key]]));
}
function checks(value) {
  return Array.isArray(value) ? value.filter((item) => layers.has(item.layer) && ['pass', 'fail', 'unknown'].includes(item.status))
    .slice(0, 5).map((item) => ({ layer: item.layer, status: item.status })) : [];
}
function snapshot(value) {
  return value && typeof value.exists === 'boolean' && (value.exists ? /^[a-f0-9]{64}$/.test(value.sha256) : value.sha256 === null)
    ? { exists: value.exists, sha256: value.sha256 } : null;
}

export function projectQuestion(value) {
  if (!value || !Number.isSafeInteger(value.previewRevision) || value.previewRevision < 1 || !Array.isArray(value.choices)
      || !value.choices.length || value.choices.some((item) => !choices.has(item))) throw new Error('问题投影无效。');
  return {
    previewRevision: value.previewRevision, expiresAt: Number.isFinite(value.expiresAt) ? value.expiresAt : null,
    title: safeString(value.title, 512), impact: safeString(value.impact), path: safeString(value.path),
    resource: ['connection', 'forwarding', 'settings'].includes(value.resource) ? value.resource : null,
    choices: value.choices, changes: strings(value.changes), steps: strings(value.steps),
    before: snapshot(value.before), after: snapshot(value.after),
    connection: selected(value.connection, ['alias', 'hostname', 'username', 'sshPort', 'sshConfig']),
    localProxy: safeString(value.localProxy), remotePort: Number.isSafeInteger(value.remotePort) ? value.remotePort : null,
    version: safeString(value.version, 100), fallback: safeString(value.fallback),
    guide: typeof value.guide === 'string' && /^https:\/\/(?:code\.visualstudio\.com|learn\.chatgpt\.com|marketplace\.visualstudio\.com)\//.test(value.guide) ? value.guide : null,
  };
}
export function projectResult(value) {
  if (!value || !outcomes.has(value.outcome)) throw new Error('结果投影无效。');
  return {
    outcome: value.outcome, stage: stages.has(value.stage) ? value.stage : 'state', checks: checks(value.checks),
    target: selected(value.target, ['targetId', 'targetRevision', 'alias', 'hostname', 'username', 'lifecycle', 'cycleStatus']),
    nextAction: typeof value.nextAction === 'string' ? safeString(value.nextAction, 256) : value.nextAction ? {
      ...selected(value.nextAction, ['kind', 'status', 'expected']), missing: Array.isArray(value.nextAction.missing)
        ? value.nextAction.missing.filter((item) => ['vscode', 'remote-ssh', 'openssh', 'curl', 'ssh-config-entry', 'openssh-entry', 'server-install-path'].includes(item)) : [],
    } : null,
    userUsability: value.userUsability === 'user-confirmed' ? 'user-confirmed' : 'unconfirmed',
    proxyAttribution: 'unconfirmed',
  };
}
export function projectStoredState(observed, preferences) {
  const value = observed.current?.value;
  const cycle = value?.proxyCycles.find((item) => item.cycleId === value.currentCycleId);
  return {
    issue: observed.legacy ? 'legacy-migration-required' : observed.pending.length ? 'transition-review-required' : null,
    stateRecovery: observed.legacy || observed.pending.length === 1 ? { expectedEntryHash: observed.entry?.hash ?? null } : null,
    entryRevision: observed.entry?.value.entryRevision ?? null,
    target: value ? { ...selected(value, ['targetId', 'targetRevision', 'lifecycle']),
      connection: selected(value.connection, ['alias', 'hostname', 'username', 'sshPort', 'sshConfig']),
      cycleStatus: cycle?.status ?? null, resources: { connection: value.connectionResource.state, forwarding: cycle?.forwarding.state ?? null,
        settings: cycle?.settings.state ?? null }, historicalChecks: checks(value.lastChecks?.checks), historical: true } : null,
    preferences: preferences ? selected(preferences.value, ['revision', 'localProxy', 'remotePort', 'sshConfig', 'codePath']) : null,
  };
}
