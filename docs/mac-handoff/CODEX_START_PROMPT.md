# 给 Mac 上 Codex 的开场消息

在 Mac 上克隆仓库或更新到最新 main 后，把下面文本复制到该仓库的新会话。它是交接建议，不是自动执行脚本。

```text
这是已从 GitHub 获取的 Windows 项目仓库，位于当前工作区，现要在 Mac 上接手开发。

目标：在这台 Mac 上，实现给新 Linux 云容器准备 VS Code Remote SSH、
把 Mac 已有本地 HTTP 代理通过反向转发提供给远端 Codex、保存进度并支持安全移除和弃用。

先阅读 docs/mac-handoff/README.md，再读同目录 OVERVIEW.md、CURRENT_STATE.md、
LESSONS_LEARNED.md、MAC_ANALYSIS_AND_PLAN.md 和 DOCUMENT_MAP.md；
按导航补齐 v0.3 PRD、架构、Spec、安全边界和最新验证补记。
源码在仓库根目录的 app/、scripts/ 和 tests/。

先做这台 Mac 的只读分析：系统/架构、Node、VS Code 的实际 .app/CLI/profile、
Remote SSH、SSH/SCP/curl、用户目录权限、原生终端与 Finder 入口、现有本机代理。
明确已知事实、假设、平台差异和待实测项，再起草 Mac PRD 增量、架构差异和详细实施 Spec。
交接文档是参考资料，不是现成 Mac 安装包；不要直接执行 Windows 入口、导入 Windows 恢复状态，
或把历史 Windows 测试数字记成 Mac 通过。

优先最小改造：保留共享 runOperation、五操作、v3 资源/周期契约与 Linux 远端协议，
适配本机入口、工具定位、权限、状态目录、进程身份、恢复互斥和打包。
继续采用轻量本地网页 + 原生认证终端；不要默认重做 VS Code 插件、Electron 或插件下载器。
Codex 插件由目标远端窗口的官方商店安装。产品不采集、保存或代填密码，不读取登录凭证。

按可验证单元实施，每阶段自查、修复、复验后继续，例行实现选择自主推进。
必须实测的项保留待验证；不以模拟、旧容器、五层网络检查或旧聊天回复替代真实验收。
修改真实用户配置前保留准确预览与确认；测试目标需本次明确选择的可信 Linux，
没有目标时先继续所有不依赖它的工作。不要自行购买或重建云资源。
不因交接文档提到历史代操作就假定这台 Mac 的任意认证/目标已经获授权。

请先给出本机分析结果和最小实施方案，再按已明确范围推进。
```

如果需要更短的版本：

> 请先读取 `docs/mac-handoff/README.md`，理解 Windows 经验与证据边界；对当前 Mac 做只读调查，形成 Mac 需求增量和实施 Spec，再以最小平台适配实现相同流程。不要直接运行 Windows 入口、继承旧恢复状态或照抄 Windows 支持结论。
