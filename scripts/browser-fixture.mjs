// 开发浏览器回归专用；远端为内存夹具，不随交付包发布。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acquireInstance, createStateStore } from './state.mjs';
import { createAppServer } from '../app/server.mjs';
import { contentSnapshot } from './config.mjs';
import { candidateCodexVersion } from './workflow.mjs';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-browser-fixture-'));
const instance = await acquireInstance(path.join(directory, 'state'));
const store = createStateStore(instance.directory, instance), config = path.join(directory, 'config');
await fs.writeFile(config, '# fixture only\n');
await store.savePreferences({ expectedRevision: null, values: { sshConfig: config, localProxy: 'http://127.0.0.1:7897', remotePort: 17890 } });
let remote = '{"editor.tabSize":2}\n'; const payloads = new Map();
const dependencies = {
  detectLocalTools: async () => ({ ready: true, vscode: { codePath: path.join(directory, 'Code.exe'), version: '1.142.0', commit: '6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1' }, remoteSshVersion: '0.128.0' }),
  probeLocalProxy: async () => {},
  sshEffective: async ({ host }) => { const block = (await fs.readFile(config, 'utf8')).split(/^Host /m).find((part) => part.startsWith(`${host}\n`)) ?? '';
    return `hostname sample.test\nuser root\nport 22\n${block.includes('RemoteForward') ? 'remoteforward 127.0.0.1:17890 127.0.0.1:7897\n' : ''}`; },
  preflightRemoteBase: async () => ({ uid: 0, home: '/root', architecture: 'x86_64', listenerTool: 'proc' }),
  remoteListeners: async () => [], locateRemoteServer: async () => ({ status: 'ready', settingsPath: '/root/.vscode-server/data/Machine/settings.json' }),
  preflightRemote: async () => ({ version: process.argv.includes('--missing-codex') ? 'missing' : `openai.chatgpt-${candidateCodexVersion}-linux-x64` }),
  remoteRead: async () => ({ text: remote, mode: '600' }),
  runScp: async (_options, local, destination) => payloads.set(path.posix.dirname(destination), await fs.readFile(local, 'utf8')),
  runRemoteProtocol: async (_options, verb, protocol) => {
    if (verb === 'allocate') return { status: 'allocated' };
    if (verb === 'write') remote = protocol.request.split('\n')[6] === 'missing' ? null : payloads.get(protocol.stageRef.directory);
    return verb === 'cleanup' ? { status: 'cleaned' } : { status: 'applied', permit: 'closed', snapshot: contentSnapshot(remote) };
  },
  verifyTarget: async () => ({ ok: true, checks: ['local-proxy', 'ssh', 'remote-endpoint', 'target-https', 'codex-process'].map((layer) => ({ layer, status: 'pass' })) }),
};
const app = await createAppServer({ store, directory: instance.directory, dependencies, onShutdown: async () => {
  await instance.release(); await fs.rm(directory, { recursive: true, force: true });
} });
console.log(`受控夹具，禁止用于真实配置：${app.url}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close());
