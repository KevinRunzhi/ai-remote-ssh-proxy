const $ = (selector) => document.querySelector(selector);
const storageKey = 'codex-local-session';
const fragment = location.hash.slice(1);
let token = fragment;
try { token ||= sessionStorage.getItem(storageKey); if (fragment) sessionStorage.setItem(storageKey, fragment); } catch { /* 内存会话仍可使用。 */ }
if (fragment) history.replaceState(null, '', '/');
let state, questionId, submitting = false, stopped = false, filled = false, shuttingDown = false;
const stageNames = { state: '核对记录', 'local-preflight': '本机准备', 'remote-preflight': '远端基础检查', reconcile: '核对未完成动作', connection: '建立连接', forwarding: '配置转发', server: '准备 Server', settings: '远端代理字段', codex: '准备 Codex', verify: '独立检查', remove: '移除代理', abandon: '弃用旧容器' };
const nextNames = { 'prepare-server': '在 VS Code 连接目标，准备好后继续。', 'prepare-codex': '在目标远端窗口准备 Codex 后继续。', reconnect: '保存工作，关闭对应远端窗口，用同一 alias 重连后继续。', 'user-request': '在目标 Codex 发起真实请求后再次检查。', 'proxy-attribution-required': '新回复已由你确认；实际代理路径仍待关联证据。', 'review-checks-and-reconnect': '检查未全部通过，请核对端口、重连和 Codex 运行位置。', 'reconcile-resource': '有写入或清理结果待核对，请继续原目标；无法核对时保留记录。', 'explicit-reconfiguration-required': '已移除代理；请勾选新周期后再继续。', 'finish-remove-first': '部分代理已移除，请先完成移除。', 'reconnect-to-release-listener': '代理增量已恢复，SSH 连接保留；重连可释放旧会话监听。', 'ssh-connection-retained': '没有待移除代理；SSH 连接保留。', 'initialize-new-container': '旧目标已归档，现在可初始化新容器。', 'review-effective-ssh': '有效 SSH 配置核对失败，当前增量已尝试撤销，请核对 SSH 入口。', 'review-and-retry': '当前阶段未完成，请核对输入与原生终端提示后重试。' };
const layerNames = { 'local-proxy': '本机代理', ssh: 'SSH', 'remote-endpoint': '远端入口', 'target-https': '目标 HTTPS', 'codex-process': 'Codex 进程' };
nextNames['legacy-remote-review-required'] = '旧记录缺少可关闭的远端写入许可，暂不能自动继续或移除。可选择“弃用旧容器”，保留远端并归档，再初始化新容器；此操作不连接旧远端。';
const choiceNames = { confirm: '确认此变更', cancel: '取消', ready: '已完成，重新检查', later: '稍后继续', cleanup: '清理本机增量', retain: '全部保留', 'remove-connection': '移除工具新建连接', 'retain-connection': '保留连接', 'new-reply': '已收到本次新回复' };
function error(message) { $('#error').textContent = message; $('#error').hidden = !message; }
function paragraph(parent, text, tag = 'p') { if (text === null || text === undefined || text === '') return; const element = document.createElement(tag); element.textContent = text; parent.append(element); }
async function api(route, data) {
  const response = await fetch(route, { method: data ? 'POST' : 'GET', headers: { 'X-Codex-Session': token ?? '', ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求未完成。'); return result;
}
async function post(route, body) { return api(route, { requestId: crypto.randomUUID(), ...body }); }
function renderQuestion(question) {
  $('#question').hidden = !question;
  if (!question) { questionId = null; return; }
  if (question.questionId === questionId) return; questionId = question.questionId;
  $('#question-title').textContent = question.title;
  const body = $('#question-body'); body.replaceChildren();
  paragraph(body, question.impact); paragraph(body, question.path, 'code');
  if (question.version) paragraph(body, `候选版本：${question.version}`);
  if (question.connection) for (const [key, label] of [['alias', 'SSH alias'], ['hostname', '主机'], ['username', '用户'], ['sshPort', '端口'], ['sshConfig', 'SSH config']]) paragraph(body, `${label}：${question.connection[key] ?? '未知'}`);
  if (question.localProxy) paragraph(body, `本机代理：${question.localProxy}；远端端口：${question.remotePort}`);
  for (const change of question.changes) paragraph(body, change, 'pre');
  for (const step of question.steps) paragraph(body, step);
  paragraph(body, question.fallback);
  if (question.guide) { const link = document.createElement('a'); link.href = question.guide; link.textContent = '查看官方步骤 ↗'; link.target = '_blank'; link.rel = 'noreferrer'; body.append(link); }
  const actions = $('#question-actions'); actions.replaceChildren();
  for (const choice of question.choices) {
    const button = document.createElement('button'); button.textContent = choiceNames[choice] || choice;
    if (['cancel', 'later', 'retain', 'retain-connection'].includes(choice)) button.className = 'subtle';
    button.addEventListener('click', () => submit(async () => {
      await post(`/api/operations/${state.operation.operationId}/answer`, { questionId: question.questionId, previewRevision: question.previewRevision, choice });
    })); actions.append(button);
  }
}
function render() {
  if (stopped) {
    $('#status-heading').textContent = shuttingDown ? '服务已关闭' : '本地会话不可用';
    $('#message').textContent = shuttingDown ? '请在启动终端确认收尾结果。' : '请使用启动终端提供的本次地址。';
    $('#question').hidden = true;
    document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    return;
  }
  const operation = state.operation, target = state.stored?.target;
  const probe = state.mode === 'authentication-probe';
  const busy = ['running', 'waiting-user', 'cancelling'].includes(operation?.status);
  document.querySelectorAll('.business-fields').forEach((element) => { if (element.id !== 'target-actions') element.hidden = probe; });
  if (!filled) {
    const preferences = state.stored?.preferences;
    $('#ssh-config').value = preferences?.sshConfig ?? (probe ? '' : state.defaults.sshConfig);
    if (preferences) { $('#proxy').value = preferences.localProxy; $('#remote-port').value = preferences.remotePort; $('#code-path').value = preferences.codePath ?? ''; }
    filled = true;
  }
  if (probe) { $('#page-title').textContent = '先连通，再准备。'; $('#page-description').textContent = '只读认证探针，不配置代理，不安装软件。'; $('#run').textContent = '运行只读探针 ↗'; }
  const unavailable = stopped || state.stopping || submitting;
  $('#record-review').hidden = !state.stored?.stateRecovery;
  $('#review-records').disabled = unavailable || busy;
  $('#run').disabled = unavailable || busy || !probe && (!!target || !!state.stored?.issue);
  $('#connect-form').querySelectorAll('input,button').forEach((element) => { if (element.id !== 'run') element.disabled = unavailable || busy; });
  $('#cancel').disabled = unavailable || !busy;
  $('#cancel').textContent = operation?.status === 'cancelling' ? '停止进一步收尾' : '取消操作';
  $('#shutdown').disabled = unavailable;
  $('#current').hidden = !target;
  $('#target-actions').hidden = probe || !target;
  if (target) {
    $('#target-name').textContent = target.connection.alias;
    $('#target-detail').textContent = `${target.connection.username ?? '未知用户'} @ ${target.connection.hostname ?? '未知地址'} · ${target.lifecycle} · 记录是历史进度，在线状态需要重新检查`;
    $('#target-resources').textContent = `连接 ${target.resources.connection} / 转发 ${target.resources.forwarding ?? '未开始'} / settings ${target.resources.settings ?? '未开始'}`;
    $('#reconfigure-label').hidden = target.cycleStatus !== 'removed';
    document.querySelectorAll('[data-operation]').forEach((button) => { button.disabled = unavailable || busy || !!state.stored?.issue || target.lifecycle === 'abandoning' && button.dataset.operation !== 'abandon'; });
  }
  const names = { running: '正在执行', 'waiting-user': operation?.waitingQuestion ? '等待你的选择' : '请切换到原生终端', cancelling: '正在收尾', succeeded: operation?.result?.outcome === 'needs-user' ? '等待继续' : probe ? 'SSH 探针通过' : '本次操作完成', failed: '当前阶段未通过', cancelled: '已取消本次操作', 'recovery-required': '需要核对恢复状态' };
  $('#status-heading').textContent = state.stopping ? '正在退出' : names[operation?.status] || '等待开始';
  const next = operation?.result?.nextAction;
  const missingNames = { vscode: '安装 VS Code Stable', 'remote-ssh': '安装 Remote SSH', openssh: '启用 Windows OpenSSH 客户端', curl: '准备系统 curl', 'ssh-config-entry': '确认 VS Code Remote SSH 与表单使用同一 config 路径', 'openssh-entry': '确认 VS Code 使用系统 OpenSSH', 'server-install-path': '自定义 Server 安装路径尚不支持，请核对目标窗口' };
  const nextKindNames = { 'codex-check': 'Codex 有效注册、平台或静态调用链检查未完成。请查看目标窗口的 Codex 日志，保留现有安装后重试。', 'codex-version': '已安装的 Codex 与内部候选版本不同，保留现有安装并核对版本。' };
  const detail = typeof next === 'string' ? nextNames[next] : next ? `${nextKindNames[next.kind] || `需要处理：${next.kind}`}${next.status ? `（${next.status}）` : ''}${next.expected ? `，候选版本 ${next.expected}` : ''}${next.missing?.length ? `\n${next.missing.map((item) => missingNames[item]).join('；')}` : ''}` : '';
  $('#message').textContent = state.stored?.issue ? '状态需要受控核对，当前不允许写入。请保留原记录，查看启动终端。' : [operation?.message || '确认本机参数后，开始准备新容器。', detail].filter(Boolean).join('\n');
  const stages = $('#stages'); stages.replaceChildren();
  if (operation?.stage) paragraph(stages, stageNames[operation.stage] || '执行中', 'li');
  const checks = $('#checks'); checks.replaceChildren();
  for (const check of operation?.checks ?? []) paragraph(checks, `${check.status === 'pass' ? '✓' : check.status === 'fail' ? '×' : '○'} ${layerNames[check.layer]} · ${check.status === 'pass' ? '通过' : check.status === 'fail' ? '失败' : '未知'}`);
  $('#evidence').textContent = operation?.result ? `本次新回复：${operation.result.userUsability === 'user-confirmed' ? '用户已确认' : '未确认'}；实际代理路径：未归因。` : '';
  renderQuestion(operation?.waitingQuestion);
  $('#question-actions').querySelectorAll('button').forEach((button) => { button.disabled = unavailable || operation?.status === 'cancelling'; });
}
async function poll() {
  if (stopped) return;
  try { state = await api('/api/state'); render(); }
  catch (cause) {
    $('#status-heading').textContent = shuttingDown ? '服务已关闭' : '本地会话不可用';
    error(shuttingDown ? '请在启动终端确认收尾结果。' : cause.message);
    document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    if (!token || shuttingDown) stopped = true;
  } finally { if (!stopped) setTimeout(poll, 1000); }
}
async function submit(action) {
  if (submitting) return; submitting = true; error(''); if (state) render();
  try { await action(); state = await api('/api/state'); }
  catch (cause) {
    if (shuttingDown) { stopped = true; error(''); }
    else error(cause.message);
  }
  finally { submitting = false; if (state) render(); }
}
function preferences() {
  return { localProxy: $('#proxy').value.trim(), remotePort: Number($('#remote-port').value), sshConfig: $('#ssh-config').value.trim(),
    ...($('#code-path').value.trim() ? { codePath: $('#code-path').value.trim() } : {}) };
}
$('#connect-form').addEventListener('submit', (event) => {
  event.preventDefault(); if (!state || $('#run').disabled) return;
  submit(async () => {
    let sshCommand = $('#host').value.trim(); if (!sshCommand.startsWith('ssh ')) sshCommand = `ssh ${sshCommand}`;
    const probe = state.mode === 'authentication-probe';
    if (!probe && !$('#new-container').checked) throw new Error('请明确勾选新建/重建容器声明。');
    await post('/api/operations', { kind: probe ? 'probe' : 'initialize', options: probe
      ? { sshCommand, sshConfig: $('#ssh-config').value.trim() }
      : { sshCommand, ...preferences(), declaration: 'new-or-rebuilt' } });
  });
});
$('#save-preferences').addEventListener('click', () => submit(() => post('/api/preferences', { expectedPreferencesRevision: state.stored?.preferences?.revision ?? null, preferences: preferences() })));
$('#review-records').addEventListener('click', () => submit(() => post('/api/operations', { kind: 'resume', options: { stateRecovery: state.stored.stateRecovery } })));
document.querySelectorAll('[data-operation]').forEach((button) => button.addEventListener('click', () => submit(async () => {
  const kind = button.dataset.operation, target = state.stored.target;
  if (kind !== 'abandon' && !$('#original-container').checked) throw new Error('请明确确认这是记录中的原容器。');
  await post('/api/operations', { kind, options: { targetId: target.targetId, expectedTargetRevision: target.targetRevision,
    ...(kind !== 'abandon' ? { declaration: 'original-container' } : {}), ...(kind === 'resume' && target.cycleStatus === 'removed' ? { reconfigure: $('#reconfigure').checked } : {}) } });
})));
$('#cancel').addEventListener('click', () => submit(() => post(`/api/operations/${state.operation.operationId}/cancel`, {})));
$('#shutdown').addEventListener('click', () => submit(async () => { shuttingDown = true; await post('/api/shutdown', {}); }));
poll();
