# codex-remote-ssh-proxy-automation

帮助 Windows 用户配置本地代理，让 VS Code Remote SSH 中运行于远程 Linux 的 Codex 能够联网使用。

项目处于 T0 真实环境试验阶段；已有可运行的最小验证脚本，尚不是可发布的首版工具。首版范围与验收标准以 [PRD.md](PRD.md) 为唯一依据。

安全边界见 [SECURITY.md](SECURITY.md)。

首次真实环境验证方案见 [技术架构文档](TECHNICAL_ARCHITECTURE.md)。

按任务顺序实施与验收见 [Spec 与实施计划](SPEC.md)。

T0 的 PowerShell 执行顺序、密码交互探针和当前阻塞见 [实测记录](docs/E2E_RUN.md)。
