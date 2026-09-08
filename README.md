# codex-remote-ssh-proxy-automation

帮助 Windows 用户把本地无认证 HTTP 代理通过 SSH 反向转发给远端 Linux，供 VS Code Remote SSH 中运行的 Codex 使用。

当前已完成 T5 与首版验收：`configure` / `verify` / `remove` 已在真实 Windows → Linux → VS Code Remote SSH 环境形成完整闭环，并取得实际 Codex 进程的代理路径证据；失败与恢复边界已通过受控测试。首版范围与验收标准以 [PRD.md](PRD.md) 为唯一依据。

## 前提

- Windows 11、Node.js 22 或更高版本。
- Windows 系统 OpenSSH，以及已能正常使用的 SSH Host alias。
- 受信任的 Linux 远端，已安装并登录 Codex；VS Code 中的 Codex 扩展在远端运行。
- 本地回环地址上已启动无认证 HTTP 代理。
- 通过 VS Code 的 **Open Remote Settings (JSON)** 确认远端 `settings.json` 的 Linux 绝对路径。

## 安装与配置

```powershell
npm ci
node scripts/e2e.mjs configure --host dev-linux --local-proxy http://127.0.0.1:7890 --remote-port 17890 --remote-settings /home/user/.vscode-server/data/Machine/settings.json
```

`--remote-port` 可省略，默认为 `17890`。`--host`、`--local-proxy` 或 `--remote-settings` 缺失时，交互式 PowerShell 会询问；非交互环境会停止。

参数范围：

- `configure`：`--host`、`--local-proxy`、`--remote-port`、`--ssh-config`、`--remote-settings`。
- `verify`：可用 `--host`、`--ssh-config`、`--remote-settings` 核对恢复记录；多个 Codex 后端候选时使用 `--pid`。
- `remove`：可用 `--host`、`--ssh-config`、`--remote-settings` 核对恢复记录；端口和代理从记录读取。

如果 VS Code 使用的不是默认 `%USERPROFILE%\.ssh\config`，追加绝对路径：

```powershell
--ssh-config C:\Users\you\.ssh\config
```

命令会先执行完整只读检查并展示两处增量，只有输入 `yes` 后才会写入。OpenSSH 会直接显示密码提示；脚本不读取、保存或代填密码。

配置成功后：

1. 保存远端窗口中的工作。
2. 完全关闭连接该目标的 VS Code 远端窗口。
3. 使用同一 SSH alias 重新连接，再打开 Codex。

## 验证与移除

```powershell
node scripts/e2e.mjs verify --host dev-linux
node scripts/e2e.mjs remove --host dev-linux
```

`verify` 只进行独立网络和后端环境检查，不修改配置、不创建转发、不发送模型请求。自动检查通过不等于真实 Codex 请求已完成验收。

进程检查只接受当前远端用户拥有、可执行文件位于已确认 Codex 扩展目录且带独立 `app-server` 参数的候选。如果找到多个候选，先在目标远端窗口确认 PID，再使用 `verify --host dev-linux --pid <PID>`；工具不会任选第一个。自动检查结束后，仍需由用户在对应 Codex 窗口发送新请求，并另行取得该 PID 到远端代理端口的连接证据。

`remove` 会预览并要求确认，先恢复 Remote settings，再移除本工具拥有的 SSH 片段。完成后需再次重连 VS Code Remote SSH。

## 恢复与限制

恢复记录位于 `%LOCALAPPDATA%\codex-remote-ssh-proxy-e2e\active.json`，仅保存摘要、所有权和局部恢复信息。如果命令报告“需要恢复”：

1. 不要删除 `active.json`、继续运行 `configure` 或手工覆盖配置。
2. 核对错误中列出的 SSH config、Remote settings，以及存在时的远端暂存路径；只处理消息明确列出的本次路径。
3. 保留用户后续修改，按消息给出的命令重试 `remove`。若仍提示摘要不符，停止自动移除并保留记录，人工比较这两处配置后再决定恢复内容。

如果命令报告另一个配置或移除操作正在进行，先确认所有本工具命令均已结束。仅在确认没有 `configure` 或 `remove` 仍运行时，才按错误消息给出的精确路径手动删除 `operation.lock`；不要删除 `active.json`，也不要在命令仍运行时清锁。

首版仅支持唯一、单 alias 的字面 `Host` 块，拒绝 `Include`、`Match`、链接文件、冲突转发和冲突代理字段。一次只允许一个未移除目标，不会自动换端口、停止用户进程或覆盖后续修改。

安全边界见 [SECURITY.md](SECURITY.md)，实施顺序见 [SPEC.md](SPEC.md)，脱敏实测记录见 [docs/E2E_RUN.md](docs/E2E_RUN.md)。
