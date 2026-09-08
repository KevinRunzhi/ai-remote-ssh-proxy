# T0 真实环境试验记录

> 本文件只记录脱敏结果。SSH alias、用户名、主机地址、完整配置路径、凭证及原始日志不得提交。

## 执行日期与版本组合

- 执行日期：2026-09-06 至 2026-09-07（本地演练及真实 T0 闭环已完成）
- Windows：Windows 11 Home China，10.0.26200
- Node.js：22.17.0
- OpenSSH for Windows：9.5p2
- curl for Windows：8.21.0
- VS Code：1.134.0
- Remote SSH：0.124.0
- 本地 Codex 扩展：26.818.41705（仅作本地静态参考）
- Linux：Ubuntu 22.04
- 远端 Codex 扩展：用户已确认安装、登录并在 Running Extensions 中运行于远端；远端扩展 `openai.chatgpt-26.901.22334-linux-x64` 的代理启动静态调用链真实检查通过

## 测试目标与配置

- 测试目标代称：独立测试机（私有 alias 不入库）
- SSH alias：仅保存在本地恢复记录，不写入本文件
- SSH 配置入口已确认：是，默认用户 `.ssh/config`
- Remote settings 路径已确认：是，标准 Machine settings 路径
- 本地代理：`http://127.0.0.1:7897`
- 远端入口：`127.0.0.1:17890`

## 运行顺序

以下命令必须在交互式 PowerShell 中运行，`<新测试机 alias>` 仅替换为用户新建的独立测试目标：

```powershell
npm ci
node scripts/e2e.mjs rehearse
node scripts/e2e.mjs probe-auth --host <新测试机 alias> --mode inherit
node scripts/e2e.mjs probe-auth --host <新测试机 alias> --mode capture
node scripts/e2e.mjs probe-auth --host <新测试机 alias> --mode cancel
node scripts/e2e.mjs probe-transfer --host <新测试机 alias>
node scripts/e2e.mjs configure --host <新测试机 alias>
# 用户保存工作、关闭目标远端窗口并用同一 alias 重连，然后重新打开 Codex
node scripts/e2e.mjs verify --host <新测试机 alias>
node scripts/e2e.mjs observe --host <新测试机 alias> --pid <verify 输出的 PID>
# observe 开始后，用户在对应 Codex 窗口发送一条新的简短请求
node scripts/e2e.mjs configure --host <新测试机 alias>
node scripts/e2e.mjs remove --host <新测试机 alias>
```

如 VS Code 实际使用其他 SSH config，以上涉及目标的命令均追加 `--ssh-config <绝对路径>`。任何失败先停止，不继续写入或猜测恢复状态。

`cancel` 模式必须在 OpenSSH 原生密码提示出现时按 Ctrl+C，不输入密码。三个认证探针与 SCP 探针任一失败，不得继续 configure。

## 密码交互与 SCP 前置

| 步骤 | 结果 | 依据 |
| --- | --- | --- |
| 直接 SSH | 真实环境通过 | OpenSSH 显示原生密码提示，输入不回显，返回固定成功标记 |
| Node 全继承 | 真实环境通过 | OpenSSH 原生密码提示可见且输入不回显；就绪、操作与成功标记完整，退出码 0 |
| Node 捕获 stdout | 真实环境通过 | OpenSSH 原生密码提示可见且输入不回显；Node 解析就绪标记后明确提示开始执行，最终退出码 0 |
| Ctrl+C 取消 | 真实环境通过 | OpenSSH 密码提示出现后取消；SSH 非超时结束，未出现远端操作标记；Windows 子进程直接接收 Ctrl+C 的判定修正后复验通过 |
| SCP 样本传输 | 真实环境通过 | 同套系统 OpenSSH 默认协议上传成功；空格文件名、内容摘要、目录 0700、文件 0600 及最终清理均已确认 |

## 当前基线

- 本地代理：真实环境通过；7897 监听，CONNECT 200、TLS 校验成功、目标返回 401
- SSH：0a/0b 真实环境通过；Node 将 stdin/stderr 交给 OpenSSH，仅捕获 stdout
- 远端工具与端口：工具通过，监听检查使用 `/proc/net/tcp`；重连后回环端口真实检查通过
- 远端扩展运行位置与目标包静态证据：真实环境通过

## T1 实现与只读基线复验

- 实现日期：2026-09-07
- Node.js：22.17.0
- 自动测试：`node --test tests/transport.test.mjs` 与 `npm test` 均通过，共 11 项；补充覆盖本地检查取消后不启动 SSH，以及重复配置不把失效代理端点误报为正常；T0 临时撤销演练继续通过
- 进程边界：参数数组、`shell: false`、超时和 Ctrl+C 均已测试；超时后确认目标子进程不存在
- 输出边界：测试用 Token 仅进入分类器输入，分层结果不包含该值；SSH/SCP 原生认证提示仍直接交给 OpenSSH
- 真实只读检查：本地代理通过，CONNECT 200、TLS 有效、目标 401；SSH、远端工具、Remote settings 只读获取及远端扩展静态调用链检查通过，监听检查使用 `/proc/net/tcp`
- 远端入口：候选端口 `17890` 空闲，符合 T0 配置已经撤销后的基线；检查连接包含 `ClearAllForwardings=yes`，没有创建待验证的转发
- 目标 HTTPS：当前无预期转发和监听，未从远端执行，分层结果为 `unknown`；没有把缺少入口误报为目标网络成功
- 当前结论：T1 通过；能在不修改配置的情况下区分本地代理、SSH、远端入口与目标 HTTPS 检查前提，命令退出后没有遗留检查进程

## T2 配置编辑实现

- 实现日期：2026-09-07
- 自动测试：`node --test tests/config.test.mjs` 通过 16 项，`npm test` 全量通过 27 项；补充覆盖完整 Host 块冲突扫描、省略绑定地址的同端口冲突，以及本地暂存写入失败后的清理与残留报告
- 编辑边界：SSH 仅处理唯一、单 alias 的字面 Host 块；JSONC 使用局部编辑并保留注释、换行和无关设置；重复执行无增量，等价用户值不取得所有权
- 写入边界：本地写入检查普通文件与原摘要，使用同目录临时文件并复读；远端写入先检查工具，经受限本地临时文件和 SCP 私有暂存传输，再核对原文件、上传内容及结果摘要
- 恢复边界：恢复记录不含完整配置或无关设置正文；当前摘要变化时停止，远端写失败后本地配置恢复，恢复记录创建失败时用户文件不变
- 当前结论：T2 通过；尚未接入 `configure` / `remove` 命令，接线与命令级故障恢复属于 T3

## T0 样本试验

- 临时文件撤销演练：自动测试通过
- 配置预览与应用：真实环境通过；监听检查使用 Linux `/proc/net/tcp`，首次端口检查无冲突；用户确认预览后，SSH 标记片段与 Remote settings 两字段已写入并复读通过，SCP 暂存已清理，恢复记录已保留
- 用户重连：首次 verify 仍为配置写入前的旧 SSH 进程；完全关闭后重连，第二次 verify 确认 `127.0.0.1:17890` 仅 IPv4 回环监听
- 实际 Codex 进程采用代理：真实环境通过；修正为精确匹配独立 `app-server` 参数后，确认 PID 1182 的 `HTTP_PROXY` / `HTTPS_PROXY` 匹配 `http://127.0.0.1:17890`，无小写冲突或目标绕过
- 用户新请求：真实环境通过；用户在观察窗口内发送“只回复 OK，不执行工具”，并收到新的 `OK` 回复
- 主动探测已结束：是；verify 的 curl 在 observe 和用户新请求前已结束
- 目标进程与代理路径关联：真实环境通过；第二次 observe 完整运行 60 秒，PID 1182 到 `127.0.0.1:17890` 的连接命中 97 次，时间为 `2026-09-07T02:10:34Z` 至 `02:11:33Z`；用户确认新请求与新回复均发生在该窗口内
- 重复配置：真实环境通过；第二次运行确认配置无增量，已知回环端点仍在监听，首次恢复信息保持不变
- 撤销：真实环境通过；Remote settings 与本工具拥有的 SSH 标记片段已按摘要恢复并复读，恢复记录已删除
- 撤销后重连与普通 SSH：真实环境通过；同一目标可重连，Codex 面板可打开，用户文件正常
- 撤销后的网络表现：Codex 请求显示 `Reconnecting`；与代理字段及 SSH 转发已撤销、测试机恢复到原始无直连能力的基线一致，不作为撤销失败
- 远端入口消失复查：真实环境通过；撤销并完全重连后 `/proc/net/tcp*` 未发现 `17890` 监听

## 分层结果

| 层级 | 结果 | 依据 |
| --- | --- | --- |
| 本地代理 | 真实环境通过 | 7897 监听；CONNECT 200、TLS 有效、目标 401 |
| SSH | 0a/0b 真实环境通过 | 直接 `ssh`、Node 全终端继承、stdout 捕获、Ctrl+C 取消及 SCP 私有暂存传输均通过 |
| 远端入口 | 真实环境通过并已撤销 | 配置期间仅检测到 `127.0.0.1:17890` IPv4 回环监听；撤销并重连后监听消失 |
| 目标 HTTPS | 真实环境通过 | 远端经该入口 CONNECT 200、TLS 有效、目标返回 401 |
| Codex 进程 | 真实环境通过 | PID 1182 的 HTTP/HTTPS 代理字段匹配远端入口，无冲突绕过 |

## 失败用例与里程碑

- 失败用例：未执行；T5 范围不在本任务内
- T0：通过；实际 Codex 进程采用代理、用户请求经该路径成功、全部试验改动已安全撤销
- M1：未通过；仍待 T3–T4
- M2：未通过
