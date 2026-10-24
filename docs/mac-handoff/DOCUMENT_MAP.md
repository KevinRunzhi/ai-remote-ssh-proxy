# 文档、代码与依据导航

## 当前应优先看的文档

以下相对链接均以当前 GitHub 仓库结构为准。

| 文档 | 用途 | 阅读重点 |
| --- | --- | --- |
| [根 PRD 导航](../../PRD.md) | 区分 v0.1、v0.2 与当前 v0.3 | 先看版本导航，不把下方历史范围当 Mac 禁令 |
| [v0.3 PRD](../PRD_V0.3.md) | 当前 Windows 业务需求 | D01–D08、用户流程、所有权/取消/弃用、A01–A23 |
| [v0.3 技术架构](../TECHNICAL_ARCHITECTURE_V0.3.md) | 控制路径、模块与职责 | 原生认证、共享工作流、状态恢复、首次联网顺序 |
| [v0.3 Spec](../SPEC_V0.3.md) | 详细接口、数据与实施契约 | 第 4/5/6/7/8/9 节；S00–S10、A01–A23 与最新执行记录 |
| [安全边界](../../SECURITY.md) | 配置保护、信任与秘密处理 | 不改认证、原生 SSH、用户后续修改与 unknown |
| [v0.3 验证记录](../E2E_RUN_V0.3.md) | 事实证据及失败历史 | 读最新日期补记；早期“待测”不代表后来没实施 |
| [项目状态](../PROJECT_STATUS.md) | 当前入口与历史基线 | 顶部当前导航；下方 v0.1 内容是历史快照 |
| [开发说明](../DEVELOPMENT_V0.3.md) | Windows 开发入口和限制 | 不在 Mac 直接执行 Windows runtime 准备流程 |
| [候选包说明](../CANDIDATE_V0.3.md) | Windows 内部包使用边界 | 不是 Mac 安装文档，不是正式支持声明 |
| [维护者采集说明](../PROXY_OBSERVATION_V0.3.md) | 独占只读 PID/socket 证据 | 不随生产包交付，路径证据与新回复分离 |

原根目录 [Spec](../../SPEC.md)、[架构](../../TECHNICAL_ARCHITECTURE.md)及[历史 E2E](../E2E_RUN.md)是 v0.1 背景。v0.2 [PRD](../PRD_V0.2.md)与[架构](../TECHNICAL_ARCHITECTURE_V0.2.md)是已经让位于 v0.3 的插件讨论稿，不要据此开发 VS Code 插件。[暂停交接](../HANDOFF_V0.3_2026-10-24.md)保留历史暂停位置，不是最新继续点。

## 依据冲突时怎么处理

本次用户新目标是 Mac 迁移，因此 Windows 历史文档的“首版仅支持 Windows”说明原版范围，不阻止在 Mac 新项目中分析。业务与安全不变量仍应继承；平台支持条款需在 Mac PRD 增量中明确替换。

需求说明“应该怎样”；源码说明“现在实现怎样”；验证记录说明“实际证明到哪”。三者不一致时记录差异并验证，不用某份历史文档覆盖另外两种事实。Mac 方案是建议，不凌驾于用户届时的新约束或本机事实。

## 代码速查

下表路径均相对仓库根目录。

| 位置 | 主要职责 |
| --- | --- |
| `scripts/workflow.mjs` | `runOperation` 与五种业务操作、预览/等待/结果 |
| `scripts/state.mjs` | v3 状态与校验、实例/写入互斥、目标与周期、入口切换 |
| `scripts/instance-recovery.mjs` | Windows 遗留锁受控接管与进程核对，Mac 重点适配 |
| `scripts/resources.mjs` | 资源应用、核对、恢复、首次基线与暂存归属 |
| `scripts/config.mjs` | SSH/JSONC 纯计划、摘要、逆操作及历史边界 |
| `scripts/local-config.mjs` | 本机受限读写、身份检查、暂存/提交 |
| `scripts/remote-protocol.mjs` | Linux 写入许可、guard、回执与迟到写入保护 |
| `scripts/ssh.mjs` | 进程边界、SSH/SCP、HTTP/TLS、注册包与后端检查 |
| `scripts/preflight.mjs` | 不要求预装 Codex 的 Linux 基础能力探查 |
| `scripts/vscode.mjs` | Windows Code 定位、有效 Remote SSH 配置、实际 Server |
| `scripts/input.mjs` | 简单 SSH 输入、参数和路径契约 |
| `scripts/e2e.mjs` / `legacy-cli.mjs` / `legacy-state.mjs` | CLI 适配及旧版兼容/迁移 |
| `app/server.mjs` / `projection.mjs` | HTTP 保护、单操作、白名单状态投影 |
| `app/public/` | 原生网页输入、预览、步骤与结果 |
| `scripts/prepare-runtime.mjs` / `package.mjs` / `integrity.mjs` / `check-package.mjs` | Windows 运行时准备与生产包验证 |
| `scripts/proxy-observer.mjs` / `observe-proxy.mjs` | 不改配置、不发请求的维护者有限采集 |
| `scripts/trial-ssh.mjs` / `trial-transfer.mjs` | 专用真实试验入口，不是用户生产入口 |
| `scripts/browser-fixture.mjs` | 受控页面夹具，不能冒充真实 Linux |
| `tests/` | 状态/传输/工作流/HTTP/平台/协议及错误分支测试 |

## 不用全读一遍才行动

第一次分析先看总体思路、证据边界、Mac 改造表，再围绕具体阶段读代码与 Spec 对应章节。纯计划逻辑与平台入口分开理解；不要从根目录旧 CLI 命令开始修改真实配置，也不要为了探索重写全项目。
