# 项目阶段总结与后续开发基线

> 更新日期：2026-09-08  
> 当前版本：v0.1 首版  
> 仓库基线：`86575b4 feat: 完善远程代理配置闭环与验收覆盖`  
> 状态：T0–T5 已完成，M1、M2 已通过；本文件用于后续开发交接，不替代 PRD。

## 1. 文档定位与依据

后续开发按以下优先级理解项目：

1. [`PRD.md`](../PRD.md)：v0.1 冻结范围与验收标准，首版唯一需求依据。
2. [`SECURITY.md`](../SECURITY.md)：配置、凭证、恢复和日志的安全边界。
3. [`TECHNICAL_ARCHITECTURE.md`](../TECHNICAL_ARCHITECTURE.md)：已验证路径及最小技术结构。
4. [`SPEC.md`](../SPEC.md)：T0–T5 的实施顺序、行为约束和完成判据。
5. [`docs/E2E_RUN.md`](E2E_RUN.md)：自动测试与真实环境验证证据。
6. 本文件：当前成果、已知限制和下一阶段开始开发前需要确认的事项。

如果本文与 PRD 冲突，以 PRD 为准。新增范围先修改并重新冻结 PRD，再修改架构、Spec 和代码。

## 2. 首版解决的问题

首版面向以下固定环境：

- 本地：Windows 11。
- 远端：受信任的 Linux。
- 连接方式：Windows OpenSSH 和既有 SSH Host alias。
- 使用位置：VS Code Remote SSH 远端窗口中的 Codex。
- 代理条件：Windows 本地已有无认证 HTTP 代理，监听在回环地址。
- 认证条件：支持 OpenSSH 原生密码登录，不要求改成公钥登录。

工具把 Windows 本地代理通过 SSH `RemoteForward` 暴露为 Linux 远端回环端口，再把远端 VS Code Machine settings 中的代理字段指向该端口。用户重连 VS Code Remote SSH 后，新启动的 Codex `app-server` 继承代理环境并通过该路径联网。

首版的核心价值不是通用 SSH 代理管理，而是将一条经过真实环境证明的最短路径自动化，并提供可验证、可恢复的配置闭环。

## 3. 已交付的用户流程

生产入口已经收敛为三个命令：

```powershell
node scripts/e2e.mjs configure --host <alias> --local-proxy http://127.0.0.1:<port> --remote-port <port> --remote-settings <Linux 绝对路径>
node scripts/e2e.mjs verify --host <alias>
node scripts/e2e.mjs remove --host <alias>
```

完整流程如下：

1. `configure` 检查本地代理、SSH、远端工具、配置文件和端口状态。
2. 工具展示 SSH config 与 Remote settings 的精确增量。
3. 用户输入 `yes` 后，工具保存恢复信息并写入两处配置。
4. 用户完全关闭目标 VS Code 远端窗口，用同一 alias 重连并重新打开 Codex。
5. `verify` 独立检查本地代理、SSH、远端代理入口、目标 HTTPS 和 Codex 后端环境。
6. 用户在对应 Codex 窗口发送真实请求；验收时将目标 `app-server` 进程连接关联到远端代理端口。
7. `remove` 按恢复记录撤销工具拥有的修改；用户再次重连后配置恢复生效。

最近一次日常使用中，用户再次完成 `configure` 并确认远程 Codex 可以正常使用。该次目标 alias、用户名和路径属于本机私有信息，没有写入仓库。

## 4. 当前技术结构

### 4.1 文件职责

| 文件 | 职责 |
| --- | --- |
| `scripts/e2e.mjs` | CLI 参数、交互确认、工作流编排、状态记录、配置和恢复事务 |
| `scripts/ssh.mjs` | `ssh` / `scp` / `curl` 子进程边界、超时、只读检查和五层验证 |
| `scripts/config.mjs` | SSH config 与 JSONC 的局部编辑、摘要校验、原子写入和恢复 |
| `tests/config.test.mjs` | 配置编辑、所有权、原子写入、恢复和秘密过滤测试 |
| `tests/transport.test.mjs` | SSH/SCP/curl、超时、网络分层和进程证据测试 |
| `tests/workflow.test.mjs` | configure/verify/remove 工作流、锁、失败恢复和输出测试 |

运行时只依赖 Node.js 22+、系统 OpenSSH、系统 curl 和 `jsonc-parser@3.3.1`。没有常驻服务、GUI、数据库或后台守护进程。

### 4.2 数据路径

```text
远端 Codex app-server
        │ HTTP_PROXY / HTTPS_PROXY
        ▼
Linux 127.0.0.1:<remote-port>
        │ SSH RemoteForward
        ▼
Windows 127.0.0.1:<local-proxy-port>
        │ CONNECT + TLS
        ▼
目标 HTTPS 服务
```

只修改两处用户配置：

- Windows SSH config 中目标 Host 块内的一段带标记 `RemoteForward`。
- Linux 远端 VS Code Machine settings 中 `http.useLocalProxyConfiguration` 和 `http.proxy` 两个字段。

不修改服务器认证、Codex 登录凭证、`.bashrc`、系统环境变量、Codex `config.toml` 或 TLS 校验设置。

### 4.3 状态与恢复

活动恢复记录位于：

```text
%LOCALAPPDATA%\codex-remote-ssh-proxy-e2e\active.json
```

记录只保存必要的摘要、所有权、局部逆操作信息和步骤状态，不保存密码、Token、SSH 密钥、完整 settings 文件或完整进程环境。

配置与移除使用全局 `operation.lock` 串行化。写入前后均核对摘要；无法确认远端状态时保留恢复记录和已知残留位置，不继续覆盖或声称已经恢复。

## 5. T0–T5 完成情况

| 阶段 | 完成内容 | 主要证据 |
| --- | --- | --- |
| T0 | 在一套真实 Windows → Linux 环境验证密码交互、SCP、反向转发、远端设置、Codex 进程继承、真实请求归因和安全撤销 | 目标进程到代理端口的连接命中；用户收到新回复；撤销后端口消失且普通 SSH 正常 |
| T1 | 整理只读传输和网络检查，建立本地代理、SSH、远端入口、目标 HTTPS 的分层结果 | 真实只读基线通过；自动测试覆盖取消、超时和输出过滤 |
| T2 | 实现 SSH config 与 Remote settings 的局部、幂等、可恢复编辑 | JSONC 注释和无关字段保留；等价配置不取得所有权；写入与恢复测试通过 |
| T3 | 接通 `configure`、`verify`、`remove` 的参数、交互、锁和恢复工作流 | 确认拒绝无写入、重复配置无增量、远端写失败逆序恢复等测试通过 |
| T4 | 完成 `verify` 五层检查和命令级真实 E2E | 五层检查通过；确认实际 `app-server` 代理环境、请求连接关联、重复配置和安全移除 |
| T5 | 补齐 PRD 中的失败验收、恢复说明和用户运行文档 | 55 项自动测试通过；README、Spec 和脱敏 E2E 记录完成 |

里程碑结果：

- M1 已通过：真实环境中的配置、重连、独立验证、用户请求归因、重复配置和移除形成闭环。
- M2 已通过：M1 成立，PRD 要求的失败分支、恢复说明和运行说明已补齐。

## 6. 已验证的行为

### 6.1 真实环境已经证明

- OpenSSH 原生密码提示可见，输入不由工具读取、保存或代填。
- Node 子进程能够保留密码交互，同时捕获需要解析的 stdout。
- SCP 能安全传输包含空格路径的暂存文件，并核对权限和摘要。
- 本地代理与远端入口可以使用不同端口。
- SSH 反向转发只监听远端 IPv4 回环地址。
- 远端目标 HTTPS 探测经过代理，CONNECT、TLS 和预期 HTTP 响应成立。
- 目标 Codex `app-server` 使用预期 `HTTP_PROXY` / `HTTPS_PROXY`，没有小写冲突或目标绕过。
- 用户真实请求期间，目标进程与远端代理端口存在直接连接关联。
- 重复配置不产生新增内容，并保留首次恢复信息。
- 安全移除后，本工具片段、代理字段、活动记录和远端监听按预期恢复。

### 6.2 自动测试已经覆盖

- 本地代理未启动。
- SSH 失败、取消、认证超时及未知错误。
- SCP 上传中断、替换后摘要异常和暂存清理失败。
- 远端端口被来源不明的进程占用。
- 用户已有等价配置和重复执行。
- 已知转发存在但重连后监听尚未生效。
- 只有其他请求的同时段代理日志，缺少目标进程关联。
- 本地写入失败、远端写入失败或回复丢失。
- 用户在配置后再次修改文件，导致自动移除无法安全进行。
- 输出和恢复记录不泄露测试 Token、完整配置或原始环境。

真实环境没有进行会破坏用户代理、网络或配置的故障注入；对应失败路径使用受控自动测试证明。

## 7. 当前安全与可靠性边界

- 所有写入都在明确预览并收到 `yes` 后进行。
- SSH 密码完全由系统 OpenSSH 处理。
- 子进程使用参数数组和 `shell: false`，远端只执行固定模板与校验后的参数。
- 配置写入前后核对 SHA-256 摘要，避免覆盖并发修改。
- 本地使用同目录临时文件和原子替换；远端使用私有 SCP 暂存、摘要核对和同目录替换。
- 工具只移除自己拥有的 SSH 片段和设置字段；用户等价配置不会被删除。
- 如果用户在配置后修改目标文件，工具停止自动恢复并保留证据。
- verify 不创建被验证的转发、不修改配置、不发送模型请求。
- 网络可达不等于 Codex 可用；最终请求仍由用户发起并确认。

## 8. 当前明确限制

这些限制是 v0.1 的范围选择，不是当前缺陷：

- 仅支持 Windows 本地、Linux 远端和 VS Code Remote SSH 中的 Codex。
- 一次只管理一个未移除目标；活动恢复记录会绑定本次 alias、端口和路径。
- 新目标需要先移除当前目标，随后重新运行 configure。
- 不批量配置多台服务器，不维护历史事务列表。
- 不自动发现代理、SSH alias 或 Remote settings 路径。
- SSH config 只接受唯一、单 alias 的字面 Host 块；含 `Include` 或 `Match` 时停止。
- 本地代理必须是回环地址上的无认证 HTTP 代理。
- 远端入口固定绑定 `127.0.0.1`；不支持不受信任的共享服务器。
- 不负责代理进程启动、保活、端口自动切换或停止占用进程。
- 不自动操作 VS Code，不自动重连，不自动发送 Codex 请求。
- 不提供 GUI、稳定机器协议、自动更新或多平台发布。

## 9. 后续开发的起点

开始 v0.2 前，先根据真实使用反馈选择一个明确问题，不要直接把工具扩展为通用 SSH 管理器。当前可供评估的候选方向包括：

1. 多目标管理：保存多份独立恢复记录，让不同 alias 可以分别 configure/verify/remove。
2. 降低输入成本：在不猜测和不扩大写入范围的前提下，辅助发现 Remote settings 路径或复用最近参数。
3. SSH config 兼容性：评估安全支持常见 `Include` 布局，同时继续保证配置归属和可撤销性。
4. 日常运行体验：提供更短的交互入口、状态查看或更清晰的重连提示。
5. 分发：评估无需用户手工安装 Node 依赖的 Windows 包装方式。

以上只是候选，不属于已承诺范围。确定下一项后应依次更新：

```text
PRD 范围和验收标准
    → 技术架构中的最短验证路径
    → Spec 的实施计划与完成判据
    → 测试和实现
    → 脱敏真实环境验证记录
```

## 10. 修改前后的验证基线

当前自动验证命令：

```powershell
npm ci
npm test
git diff --check
```

当前已知基线为 55 项测试通过。后续修改至少运行与变更最相关的测试；涉及工作流、配置恢复或传输边界时运行完整 `npm test`。

涉及真实环境的改动还需要验证：

1. 写入前预览与取消无副作用。
2. configure 后完全重连才检查新会话。
3. verify 没有创建转发或修改配置。
4. 用户真实请求成功，并有目标 Codex 进程到远端代理端口的关联证据。
5. 重复配置无增量。
6. remove 只撤销工具拥有的配置，重连后普通 SSH 仍正常。

任何真实记录继续遵守脱敏要求：不提交真实 alias、用户名、主机地址、凭证、完整配置、完整环境或原始 SSH 日志。
