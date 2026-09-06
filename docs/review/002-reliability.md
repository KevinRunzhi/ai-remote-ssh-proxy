# 可靠性与实现缺口类问题（含第 2 轮复查状态）

这些问题不直接构成安全漏洞，但按当前文档实现下去，大概率在真实使用中以 bug、状态损坏或集成故障的形式出现。

状态标记同 [001-security.md](001-security.md)：✅ 已解决 / 🟡 部分解决 / ❌ 未处理 / **N** 为第 2 轮新增。

---

## 问题 7：端口可用性探测的 TOCTOU 竞态（中）✅ 已解决（且超出原建议）

**相关文档**：[ADR-0004](../adr/0004-own-ssh-forwarding-through-a-managed-include.md)、[ADR-0011](../adr/0011-distinguish-configuration-and-active-endpoint-verification.md)、[ADR-0021](../adr/0021-limit-exit-on-forward-failure-to-verification.md)

**原问题**：探测连接释放端口之后、真实隧道建立之前，远程任何进程都可能抢注端口。文档未规定竞态触发后的失败路径。

**第 2 轮状态**：✅ 已解决，方案比原建议更深。0021 没有采用我原建议的"所有真实连接一律 `ExitOnForwardFailure=yes`"，而是识别出这样做会**拒杀第二个普通 SSH/VS Code 会话**（端口已被既有会话绑定时整条连接失败），因此改为：

- 持久配置**不**设 `ExitOnForwardFailure`——普通会话不因重复绑定被拒，但可能不带转发静默连接；
- 只有隔离的 Configuration Verification 连接显式设置，获得强绑定证据；
- 由此产生的"旧会话是否真的携带转发"缺口，由 0011 的 Active Endpoint Verification（用**不带转发**的隔离连接探测端点，避免验证者自证）和 Reconnect Required 状态补上。

第 1 轮评审没有识别出"验证连接自证"和"持久 ExitOnForwardFailure 拒杀会话"这两个隐患，本组 ADR 是对问题的主动深化而非被动回应。

**残留观察（不算缺口）**：0021 承认普通会话可能"connect without owning the forwarding"——用户以为隧道生效但实际没有。该场景已由 Reconnect Required 状态覆盖，实现时需保证普通会话中的 OpenSSH "bind failed" 警告不被吞掉即可。

---

## 问题 8：多实例并发行为整体未定义（高）✅ 已解决

**相关文档**：[ADR-0012](../adr/0012-serialize-v0-1-mutations-globally.md)

**原问题**：两个产品实例并发（CLI + 未来 VS Code 扩展是设计内必然场景）会破坏 drift 检测与回滚正确性，但没有任何 ADR 讨论。

**第 2 轮状态**：✅ 已解决。0012 用全局互斥锁序列化 v0.1 的所有变更操作（只读检查可并发），并以"共享 include、本地状态存储、多别名可达同一目标的远程文件"论证了为何不能按 SSH Target 分锁；明确资源级锁可作为后续替换而不改接口；实现上优先跨平台 OS 级 advisory lock（进程终止自动释放，避免 PID 猜测），带锁目录 + 实例标识 + journal 证据的回退方案；且明确"释放或替换陈旧锁本身不解决未完成事务"。覆盖了原建议的全部要点并给出取舍理由。

---

## 问题 9：验证连接的清理与残留检测未定义（中）🟡 部分解决

**相关文档**：[ADR-0001](../adr/0001-use-system-openssh-without-a-daemon.md)、[ADR-0008](../adr/0008-delegate-ssh-trust-and-authentication-to-openssh.md)、[ADR-0012](../adr/0012-serialize-v0-1-mutations-globally.md)、[ADR-0015](../adr/0015-hide-system-ssh-behind-a-deep-openssh-module.md)

**原问题**：文档只规定正常路径不留后台 `ssh -N` 进程，未规定异常路径：CLI 被 `Ctrl-C`/`SIGKILL`、休眠、网络挂起时，ssh 子进程与远程端口残留如何处理与检测。

**第 2 轮状态**：🟡 部分解决：

- **0015** 把 OpenSSH 模块的职责清单里明确列出了 **timeouts 和 cancellation**——即超时与取消是模块契约的一部分；
- **0012** 的 OS 级锁在进程终止时自动释放，锁层面无残留问题。

**剩余缺口**：

1. 信号处理路径仍未写明：CLI 收到 SIGINT/SIGTERM 时是否（以及如何）终止 spawn 中的 ssh 子进程（独立进程组 + 退出钩子）；
2. 孤儿 ssh 进程/半开 TCP 导致的远程端口残留，`doctor` 仍无对应检测项。建议：产品通过独有的 `ControlPath` 命名标记自己的连接，`doctor` 据此枚举本产品残留；文档说明 TCP 半开下端口释放需等待 keepalive 超时，避免误诊为第三方占用（0011 的 `expected_but_unproven` 已为"端口被占但归属不明"提供了正确的报告语义，检测项可以复用它）。

---

## 问题 10：Claude Code 适配器写用户设置的行为未细化（中）✅ 已解决

**相关文档**：[ADR-0002](../adr/0002-separate-the-tunnel-core-from-tool-adapters.md)、[ADR-0020](../adr/0020-use-resource-specific-ownership-descriptors.md)、[ADR-0009](../adr/0009-ship-a-standalone-cli-before-the-vscode-extension.md)

**原问题**："Claude Code adapter prefers its user setting" 一句话没有定义目标文件、写入结构、managed 归属标记、回滚方式，导致 CONTEXT.md 的 Managed State / Drift / Rollback 三个核心概念在该适配器上无法一致实例化。

**第 2 轮状态**：✅ 已解决，方案系统性超出原建议：

- 交付分期明确：v0.1 tunnel-only + Codex，v0.2 Claude Code，且**内部适配器 seam 在第二个独立实现（Claude Code）无绕过使用之前视为未验证**——这是对抽象边界正确性的强约束；
- Claude Code 适配器贡献"语法感知的最小 JSON/JSONC 属性补丁，保留注释、格式、行尾与未知字段；语法无效、目标键重复、结构歧义一律 fail closed 而非回退到全文件序列化"；
- **0020** 为 JSON 类资源定义了基于 JSON pointer + 状态摘要的局部 Ownership Descriptor（并解释了为何统一注释方案覆盖不了 JSON、为何纯 sidecar 定位不可靠）；
- 适配器整体不再持有写文件/执行脚本权限，只产出 Desired State Contribution，由中心 Plan Compiler 编译为带前置/后置条件与补偿数据的类型化操作。

---

## 问题 11：CLI 结构化输出有承诺、无规格（中高）✅ ADR 层已解决，schema 文档待实现期产出

**相关文档**：[ADR-0006](../adr/0006-use-structured-cli-output-as-the-integration-boundary.md)、[ADR-0014](../adr/0014-provide-final-json-and-streaming-ndjson.md)、[ADR-0019](../adr/0019-version-public-and-persisted-contracts-independently.md)

**原问题**：承诺稳定 JSON、phase codes、分类退出码与版本化，但无 schema、退出码表、版本协商与 JSON 输出脱敏规则。

**第 2 轮状态**：✅ ADR 层已解决。0006（修订）明确 `--json` 输出恰一份权威 Outcome、`--json-stream` 输出版本化 NDJSON 且事件不能阻塞或控制事务、机器模式不混入本地化文本、SSH 需要终端认证时报告 `interaction_required`。0014 定义了 13 类稳定错误分类学（含 `external_unknown` 兜底：宁可不可操作也不猜测归类），并规定分类优先基于结构化前置条件与进程结果而非 stderr 模式匹配。0019 为每个契约（envelope、Outcome、Change Plan、Plan Token、Tunnel Profile、journal、适配器贡献格式）独立版本化，"未知新持久化格式只读且阻止变更"。脱敏由 0018 覆盖所有输出通道。

**剩余**：具体 schema 文档（每命令输入输出示例、退出码数值表）属于实现期产出，不阻塞当前阶段。

---

## N2（新增，第 2 轮）：journal 轮转策略与 Recovery-Required 证据可能冲突（中）

**相关文档**：[ADR-0003](../adr/0003-treat-configuration-as-a-verified-transaction.md)、[ADR-0013](../adr/0013-record-transactions-with-an-append-only-journal.md)

**现状**：0003 仍写"默认保留策略为最近 10 条记录"，而 0013 把恢复决策的权威证据放进 append-only Transaction Journal：v0.1 中 Recovery-Required 的 journal "仅在全部 mutation 与后置条件被证明时授权重新验证，否则准备 Compensating Rollback"。

**风险**：如果某条 Recovery-Required 事务的 journal 因之后 10 个无关事务被普通轮转删除，产品就失去了证明"状态仍不确定"的依据——后续命令将无法再诊断该记录，恰好违背 0003 的承诺："二次打断可能停止恢复，但**不能抹去状态不确定的证据**"。保留策略（0003）与证据不可磨灭性（0003/0013）在同一条 ADR 内部互相冲突。

**理由**：这不是实现细节，是两份持久化承诺之间的逻辑矛盾，必须在实现 journal 之前定案，否则轮转策略会按"最近 10 条"字面实现，把矛盾埋进代码。

**建议**：在 0013 明确——Recovery-Required 状态的 journal（及其引用的 Transaction Record）不参与普通轮转，或轮转前必须先将其解决/降级为确定状态；同时说明无限制保留的极端场景如何处置（例如提示用户手动确认放弃恢复，并把该决定本身记为新 journal 条目）。

---

## N3（新增，第 2 轮）：脱敏与回滚数据面的分界未明确（低中）

**相关文档**：[ADR-0018](../adr/0018-redact-evidence-before-it-enters-output-or-history.md)、[ADR-0002](../adr/0002-separate-the-tunnel-core-from-tool-adapters.md)、[ADR-0013](../adr/0013-record-transactions-with-an-append-only-journal.md)

**现状**：0018 规定证据在进入 TTY、JSON、NDJSON、应用日志、**Transaction Journal**、Support Report 之前统一脱敏，"身份与路径替换为报告局部别名"。而 0002 要求 Rollback"恢复每一个原始字符串"——被恢复的原始值（如用户原有的、含主机名的代理串）必须以真实形式存在于某处，那个地方只能是有回滚职责的持久化数据（Transaction Record / journal 的前置快照）。

**风险**：两篇 ADR 各自正确，但拼在一起存在一个**未脱敏的回滚数据面**，且没有任何文档承认它、界定它。实现者面临两种都合理的读法：把 journal/记录也脱敏到无法回滚（破坏 0002/0003 的回滚承诺），或以"回滚需要"为由绕过 0018 的统一脱敏通道（在 Redaction 模块外开洞，恰好破坏 0018 存在的理由——"哪个渲染器没更新哪个就漏"）。

**建议**：在 0018 或 0013 明确分界，例如：journal 与 Outcome 中的证据一律脱敏（存摘要 + 指向记录的引用）；Transaction Record 的**先验状态字段**是唯一豁免面，权限 `0600`、永不进入任何输出通道（Support Report 中以摘要形式出现）；回滚执行器直接从 Record 读取真实值。这样 0018 的"生产代码没有绕过脱敏的直接输出路径"仍然成立。
