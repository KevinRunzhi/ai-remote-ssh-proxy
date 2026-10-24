# 官方资料与判断依据

查阅日期：2026-10-24，Asia/Shanghai。这组文档只保留自己的简要归纳和链接，没有整页复制第三方文档。在线内容、安装布局和版本会变化，Mac 开发时应重新核对。

## 官方文档确认了什么

| 来源 | 本次简要归纳 | 不能据此断言 |
| --- | --- | --- |
| [VS Code：macOS 安装与命令行](https://code.visualstudio.com/docs/setup/mac) | 官方文档覆盖 Mac 安装和 Intel/Apple Silicon 构建；`code` 命令行 PATH 需要相应配置 | 用户当前 PATH、profile、安装位置已经正确，或 Windows Code.exe 探针能沿用 |
| [VS Code：Remote SSH](https://code.visualstudio.com/docs/remote/ssh) | Remote SSH 负责远端开发连接及 VS Code Server；支持原生 SSH 认证路径 | 本项目特定代理字段已对任意版本 Codex 生效，或本机 curl 成功等于 Server 下载成功 |
| [OpenAI：Codex IDE extension](https://learn.chatgpt.com/docs/codex/ide) | 官方页面给出扩展安装入口、打开侧栏和开始会话的流程 | 本项目内部 HTTP 代理链得到官方稳定兼容承诺；当前 Mac/Remote SSH 组合已被我们验证 |
| [OpenSSH：ssh_config](https://man.openbsd.org/ssh_config) | 配置存在优先级语义；ClearAllForwardings 用于清除配置/命令行设置的转发 | 当前 Mac 所带 Apple OpenSSH 与该手册最新实现逐项相同，仍须本机版本与有效配置验证 |
| [Node：process API](https://nodejs.org/api/process.html) | process.arch 表示当前 Node 二进制架构，platform 等是运行时字段 | 物理硬件、转译状态、远端 Linux 架构和项目固定 Node 版本可直接推导；该入口可能展示比项目更新的 Node 文档 |
| [Apple：安全打开 Mac 应用](https://support.apple.com/en-ie/102445) | macOS 对来源、签名、公证及首次打开有安全检查 | 我们的 ZIP 摘要等于签名/公证，或 Mac 发行可以默认要求关闭系统保护 |

这里只把在线文档用作入口与边界依据。具体 flags、API 和最低版本要再查所选版本的官方资料；不能因本页链接到当前 Node API，就把项目运行时擅自升级。

## 本项目自身的一手依据

- [v0.3 PRD](../PRD_V0.3.md)：用户已经选择的业务行为与范围。
- [v0.3 Spec](../SPEC_V0.3.md)：接口、状态、恢复、任务及验收契约。
- [v0.3 技术架构](../TECHNICAL_ARCHITECTURE_V0.3.md)：控制路径与实现职责。
- [v0.3 验证记录](../E2E_RUN_V0.3.md)：包括失败、修复和局部真实结果的脱敏记录。
- [当前状态摘要](CURRENT_STATE.md)：交接时的已知与未知。
- 仓库源码及测试：说明实际边界，例如 win32 门禁、系统 Mutex、registry 摘要核对、Linux 专用协议。

Mac 的平台接缝、建议数据路径、阶段计划和架构范围是根据这些源码推导的迁移建议。它们还不是已执行的 Mac 事实或官方推荐实现。具体 MAC 环境调查与新的验收回执将成为下一阶段的一手依据。
