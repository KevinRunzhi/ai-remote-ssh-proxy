# Mac 本机分析与实施建议

状态：迁移建议，尚未在 Mac 验证，也不是冻结的 Mac Spec。用户目标是保持现有业务逻辑，在实际 Mac 上先分析再开发。本文件不授权自动安装系统软件、改认证、重建云容器或接管旧写入。

## 1. 第一次在 Mac 上先调查什么

先做只读调查，生成自己的 `MAC_ENVIRONMENT.md`。不要先运行 Windows 的 `start.cmd`、`prepare-runtime.mjs` 或带真实目标的 CLI。

| 调查项 | 应记录的最小事实 | 为什么 |
| --- | --- | --- |
| 本机 OS/CPU | macOS 版本、硬件架构、运行中 Node 的 platform/arch/version、是否存在转译差异 | 本机运行时与远端 Linux 架构是两件事 |
| VS Code | 实际 `.app` 位置、Stable/其他渠道、版本/commit、CLI 可用入口、profile | 不套用 Code.exe 与 code.cmd 解析 |
| Remote SSH | 安装版本、有效 sshPath/configFile、自定义 Server 安装设置 | Code 与工具必须使用同一连接语义 |
| SSH/SCP/curl | 实际可执行文件、版本、是否系统版、SCP/SFTP 与 TTY 行为 | 确定最小可信调用路径与兼容语法 |
| 代理 | 用户实际 HTTP 回环地址、端口、服务是否已启动 | 不照搬 Windows 本机端口、不自动修改代理软件 |
| 路径/文件系统 | home、目标工作目录是否链接/同步盘、大小写行为、执行位和用户权限 | Mac 解压与权限模型不同 |
| 终端/浏览器 | 从 Terminal 启动与 Finder 双击时的 TTY/PATH、默认浏览器 | 页面能打开不证明原生认证可用 |
| 可信 Linux | 用户新选目标、原生身份确认、home/UID/发行版/架构/glibc/基础工具 | 不复用 Windows 记录中的旧容器授权 |

可以使用只读系统命令核对版本和路径，但不把完整环境变量、SSH 配置、登录文件或 credential helper 输出写进文档。没有目标时继续本机分析与纯逻辑测试；不把容器缺失升级为“整个项目无法推进”。

## 2. 逐模块适配表

以下依据交接源码定位，是需要调查的清单，不表示每行都必须重写。

| 文件/职责 | Windows 现状 | Mac 最小改造与必测行为 |
| --- | --- | --- |
| `start.cmd` | 定位随包 node.exe，在原生终端启动 | 先以 Terminal 手动入口验证；再决定 `.command` 或其他最小双击形式，验证执行位/路径/退出，暂不承诺 `.app` |
| `app/server.mjs` | Windows/TTY 门禁、Explorer 打开页面 | macOS 门禁、真实 TTY、系统浏览器打开器；URL 只能来自内部；正常退出与终端关闭收尾 |
| `scripts/ssh.mjs` | Windows OpenSSH 目录、curl.exe、交互进程与受限 stdout | 分离工具定位，核对 Mac SSH/控制终端/取消；保留参数数组、shell:false、检查清转发、禁复用与输出预算 |
| `scripts/vscode.mjs` | 验证 Code.exe、解析两个官方 code.cmd 布局、APPDATA 配置 | 实际 `.app`/官方 CLI/产品元数据探查；缺 code PATH 不等于未安装；核对有效用户配置/profile |
| `scripts/state.mjs` | LOCALAPPDATA、Windows 进程启动身份，部分 POSIX 权限分支 | 确定独立用户数据目录；实现可重读验证的 OS 进程身份，不把现有 fallback 当已通过 |
| `scripts/instance-recovery.mjs` | PowerShell、系统 Mutex、Get-CimInstance | 重做恢复互斥与进程普查适配；保持来源复核、不同恢复者竞争与不杀未知 SSH 的语义 |
| `scripts/config.mjs` | 纯配置逻辑混有 Windows SID/icacls 入口 | 复用局部编辑/摘要/逆操作；抽出本机权限能力，不让 Mac 调 icacls，也不 chmod 用户整个目录树 |
| `scripts/local-config.mjs` | 精确文件身份、受限暂存、Windows 条件 ACL | 核对创建目录 mode、已有 mode/ACL 保留、链接及原子替换；Mac 上不能默默缺少暂存权限保护 |
| `scripts/resources.mjs` | 资源归属/意图、暂存及条件 ACL | 复用事务语义，检查 POSIX 分支真实有效，原子创建与并发清理 |
| `scripts/input.mjs` | 显式输入、简单 SSH 语法、平台 path 检查 | 复验 POSIX 绝对路径、空格/Unicode；不为迁移顺手放开任意 shell、IPv6 或复杂 SSH 配置 |
| `scripts/preflight.mjs` | 远端 Linux/glibc/工具探查 | 远端仍 Linux，可复用；不要换成 Mac BSD 工具语法 |
| `scripts/remote-protocol.mjs` | Linux guard/许可/摘要/提交/恢复 | 优先原样复用，重新验证 Mac→Linux 传输与取消；绝不在本机 shell 执行该协议 |
| `scripts/workflow.mjs` | 共享五操作、阶段与重连、版本检查 | 保持唯一编排；只注入必要平台能力，不新造 Mac 网页专用恢复分支 |
| `app/public/*` | 原生单页、Windows 文案与 Code.exe 输入 | 大部分复用，改本机入口与路径文案；不把 Mac 开发细节放进产品流程 |
| `scripts/prepare-runtime.mjs` / runtime manifest | 固定 Windows x64 Node 与摘要 | 独立 darwin 架构/版本/最低 OS/官方摘要方案；先确认版本支持，非盲目用最新 Node |
| `scripts/package.mjs` / `integrity.mjs` / `check-package.mjs` | Windows tar、win32/x64/node.exe 核对 | Mac 包入口、manifest 平台、执行位、签名/隔离风险、解压回归与普通用户测试 |
| `scripts/e2e.mjs` / legacy CLI | 原生命令、历史文案与状态目录 | 共用新平台能力，明确旧 CLI 是否在 Mac 兼容范围，不复制旧 Windows 状态 |
| `scripts/proxy-observer.mjs` / `observe-proxy.mjs` | 维护者有限 Linux socket 采集，CLI 文案 Windows | 远端 PID/socket 逻辑可复用，前置检查与实例锁要适配；不默认进入用户包 |
| `tests/*` | Windows 路径/进程夹具；部分 Windows 实测条件；Linux/WSL 可选试验 | 保留纯逻辑回归，新增 Mac 平台测试；Linux 协议仍在真实 Linux 跑，不能强制用 Mac sh 代替 |

## 3. 建议维持与待决事项

保持：五操作、v3 资源契约、连接与代理分离、等价值不取得所有权、HTTP 安全边界、插件用户商店安装、原生认证、独立验证、Linux 远端协议。

待 Mac 分析后确定：

- 首个交付是否只支持用户当前 Mac 架构；Intel 与 Apple Silicon 不需要未经验证同时承诺。
- 最低 macOS、精确 Node/VS Code/Remote SSH/Codex 样本。
- 用户数据目录；`~/Library/Application Support/<应用名>` 只是候选，须实际规范化、权限与升级路径设计。
- 默认 VS Code 配置候选 `~/Library/Application Support/Code/User/settings.json` 和 `.app` 位置，须结合实际 profile/渠道核对，不能猜中就写。
- Mac 恢复互斥的最小可靠实现；是否有满足崩溃释放语义的系统机制，是否需要最小依赖。
- 首次双击入口与签名/公证分发方案。内部终端原型可先验证，不先承诺公开分发级 `.app`。

不要先把状态 version 改成 v4 或大改 runOperation API。若平台字段、状态位置或恢复身份契约确需变化，先在 Mac 文档明确迁移规则和兼容范围，再实现。已经部署的 Windows 版不能因为 Mac 特例破坏现有保护。

## 4. Mac 特别容易遗漏的细节

### 4.1 硬件架构、进程架构、远端架构

Node `process.arch` 表示运行中二进制的构建架构，并不自动证明物理机器架构。Mac 客户端 arm64 也可能连 Linux x86_64；应分别选择本机 Node 包、远端 Server/扩展后端。不要根据本机 M 系列芯片拼出 linux-arm64 包名。[Node 依据](SOURCES.md)

### 4.2 Finder 启动与 shell 环境

不能要求 Finder 自动继承开发终端的 PATH、Homebrew 或 shell profile。入口用可靠的随包路径；Code 的 CLI PATH 配置只是官方可用方式之一。密码认证必须有真实终端，不能只 `open` 一个浏览器后让无 TTY 后端等待。验证包移动目录后仍能定位资源，并避免 shell 字符串拼接用户参数。

### 4.3 普通路径本身也可能经过系统符号链接

现有 `assertPlainDirectory` 对每一级都拒绝链接。Mac 常见路径可能经过系统规范化别名；必须在本机核对真实路径后区分可信系统路径规范化与用户可变链接攻击。不要为解决一个 `/tmp` 类路径误判而全局允许 symlink，也不要对系统目录 chmod。用户 `.ssh/config` 的符号链接是否支持仍应明确界定；旧实现的拒绝语义不能静默消失。

### 4.4 权限与替换

工具私有目录建议最小权限，具体 mode 在本机实测；已有文件、ACL、所有者、扩展属性的保留要求要确定。原子 rename 后 mode 是否保留、读写之间文件被替换、Unicode 名与大小写差异、同步盘/外部卷路径都须选择明确的首版支持范围。不要假设 fs 的 Windows 条件分支一跳过，Mac 权限就已经正确。

### 4.5 macOS 不是远端 Linux

Mac 本地工具可能是 BSD 语法，而协议脚本在 Linux 上使用 GNU 工具。调用边界要在代码里清楚标出；Linux 专用测试不可因本机也是 Unix 就直接运行。Mac 的 `/proc` 假设也不适用于本机进程身份核对，远端 Linux `/proc` 采集则仍可用。

### 4.6 下载与执行门禁

Mac 分发需要处理运行时架构、文件执行位、下载来源、签名/公证和 Gatekeeper 行为。ZIP 摘要用于完整性检查，不是开发者签名。不要默认全局停用 Gatekeeper、去掉所有扩展属性或绕过恶意软件提示；按官方机制和实际分发渠道设计。具体系统确认可能仍需要用户本人，原 Windows 代操作授权不能消除系统要求。[Apple 依据](SOURCES.md)

## 5. 分阶段实施与停止条件

| 阶段 | 产出 | 通过后再推进 |
| --- | --- | --- |
| M00 阅读与本机调查 | 当前事实、Mac 环境、差异和未知项清单 | 不把 Windows 结论写成 Mac 支持；无真实配置修改 |
| M01 最小本机入口/原生认证 | 终端主进程、本地受保护页、只读 Linux 探针 | 原生认证、等待页面、正常退出、取消有真实证据 |
| M02 明确 Mac 需求增量 | Mac PRD、架构差异、实施 Spec、样本边界 | 范围与契约一致；关键歧义解决，不反复确认例行细节 |
| M03 平台能力与状态 | 目录权限、工具/Code 定位、实例/恢复互斥 | 普通用户、并发、恢复者崩溃/PID 复用、来源变化测试 |
| M04 配置与远端试验 | 本机局部提交、Linux 专用目录许可/SCP | before/after/第三种内容、取消/回执丢失/迟到写入通过 |
| M05 完整业务接线 | 五操作/CLI/页面一套流程 | 目标隔离、等价复用、移除保留连接、重配新周期通过 |
| M06 Mac 候选打包 | 固定运行时、清单摘要、最小启动入口 | Finder/Terminal、移动路径、空 PATH、损坏、无 TTY、执行位/门禁实测 |
| M07 集中验收 | 同包干净 A→不可达弃用→全新 B | 新回复+路径归因、正常移除、新 SSH 认证和全部限制登记 |

M02 可以在 M01 之前起草，但不要在没有认证入口证据前做大量写配置开发。每阶段内部有可验证单元就自查，不要求把每阶段都交用户批准。缺少真实目标时继续不依赖目标的工作，依赖项保持待验证。

## 6. Mac 验收至少覆盖的场景

- 干净本机与实际安装路径、没有独立开发 Node 的包启动；首个声明支持的 CPU/OS。
- 新 Linux 缺 Server、缺 Codex、缺 settings，以及已有等价/冲突 settings。
- 原生密码、已有用户密钥、主机身份确认与取消；官方登录单列。
- 两端不同端口、代理未启动、未知端口占用、正式 VS Code 会话存在/不存在。
- 重复点击、页面刷新、CLI/网页竞争、正常退出、真实 Ctrl+C、终端关闭、传输中断。
- 远端提交前后中断、回执丢失、迟到写入、guard busy、用户后改、恢复信号独立。
- 旧容器不可达、明确保留或清理本机增量、全新目标不继承旧身份。
- 移除只撤工具拥有的代理，普通 SSH 仍可新认证；重配创建新周期，旧恢复依据不变。
- 真正的新回复、指定进程身份与新增代理连接分别采证；自动探测结束后才进入观察窗口。

具体逐项编号应从原 A01–A23 映射到 Mac Spec，记录新增、继承与不适用的理由。原测试通过数字、模拟页面成功或旧容器可用均不能替代这张 Mac 验收表。
