# 项目治理与文档结构类问题（含第 2 轮复查状态）

这些问题不涉及运行时行为，但影响项目的可信度、可维护性和外部协作者（以及未来实现这些文档的 agent）的准确理解。状态标记同 [001-security.md](001-security.md)。

---

## 问题 12：README.md 是占位符，且项目命名不一致（中）❌ 未处理

**相关文档**：[README.md](../../README.md)

**现状**：README 仍然只有一行标题 `# codex-remote-ssh-proxy-automation`。而 `CONTEXT.md` 的项目名是 "AI Remote SSH Proxy"，ADR-0006 中的公开包名是 `ai-remote-proxy`，仓库目录名是 `ai-remote-ssh-proxy`。四处命名不一致。

**风险**：

1. README 是任何协作者/agent 进入仓库的第一入口。当前它不仅没有信息，还给出了一个与其他所有文档冲突的名称。按照 `docs/agents/domain.md` 的要求，agent 应使用 `CONTEXT.md` 的词汇表——但 README 作为更高曝光度的文件会持续误导；
2. "automation" 与产品定位（面向非技术用户的配置工具，见 ADR-0009）也不符。

**理由**：命名不一致在小项目里看似 cosmetic，但这个项目恰恰极端依赖术语一致性——`CONTEXT.md` 整个文件就是为了防止概念漂移，仓库根目录自己先漂移了。

**建议**：重写 README：项目一句话描述（复用 CONTEXT.md 的语言）、支持平台矩阵（macOS 13+/Win10 22H2+/Win11 → Linux 目标，引用 ADR-0001；v0.1/v0.2/v0.3 交付分期引用 ADR-0009 修订版）、安装与卸载入口、指向 ADR 目录和 SECURITY.md 的链接、明确的"当前状态：设计阶段，尚无实现"声明。标题统一为一个规范名。

**第 2 轮状态**：❌ 未处理。

---

## 问题 13：缺少 SECURITY.md 与成文威胁模型（高，治理类中优先级最高）❌ 未处理，必要性反而上升

**相关文档**：全部 ADR（现为 21 条）

**现状**：原评审时 9 条 ADR 中有 4 条本质上是安全决策；现在 21 条 ADR 中安全决策增加到约 10 条（新增 0012 锁、0015 注入防御与 `Match exec` 披露、0017 CAS、0018 脱敏、0020 描述符等），仍然分散在各 ADR 的正文与"范围外"段落里。没有集中的威胁模型文档，没有 SECURITY.md（漏洞披露联系方式/流程），仓库也没有开启或声明 GitHub Private Vulnerability Reporting。

**风险**：

1. **用户无法做知情决策**：安全边界分散在 21 份 ADR 里，目标用户（非技术背景，见 ADR-0009）不可能读完并正确理解"我能在什么机器上用它"；
2. **安全决策无处沉淀增量**：随着 ADR 数量翻倍，集中声明的缺失使安全立场越来越难审计。多个第 2 轮新问题（[001-security.md](001-security.md) 问题 1 的残余风险声明、N1 的 Plan Token 本地威胁模型、问题 3/4 的本地文件权限数值）都天然归属于一份集中威胁模型；
3. **没有披露渠道**：产品会修改 SSH 配置和远程 shell 文件，一旦上线后被人发现漏洞，报告者找不到任何联系方式。

**理由**：对一个修改 SSH 配置、在远程机器写可执行 shell 代码的工具来说，SECURITY.md 不是合规装饰，而是产品自身定位（"安全地放大本地代理"）的必要支撑。ADR-0005/0015/0017/0018 的质量说明作者有很强的安全意识，缺的只是把这些立场集中、显式化的载体。

**建议**：新建 `SECURITY.md`，结构建议：

1. **支持的威胁模型**：信任本地计算机（含本地进程环境，一并解决问题 N1）；信任 SSH Target 的内核隔离但**不信任其上的其他本地用户/进程**（显式写出问题 1 的残余风险与使用建议）；不信任网络路径（依赖 OpenSSH）；
2. **明确的非目标**：认证代理（0005）、GatewayPorts（0007）、非 OpenSSH 客户端（0008）、远程 Windows/WSL（0001）、多用户共享主机上的隐私（0007）——各引用对应 ADR；
3. **披露流程**：GitHub Security Advisory / Private Vulnerability Reporting 链接，响应时限承诺；
4. **实现完成后**：签名与校验和现状（引用 ADR-0009 的披露要求）。

**第 2 轮状态**：❌ 未处理。

---

## 问题 14：triage-labels.md 存在上游模板残留（低）❌ 未处理

**相关文档**：[docs/agents/triage-labels.md](../agents/triage-labels.md)

**现状**：表头列仍为 "Label in mattpocock/skills"，文末仍保留模板指令原文 "Edit the right-hand column to match whatever vocabulary you actually use"。

**风险**：很低，但 `docs/agents/` 目录的读者主要是自动化 agent，而 agent 对模板残留指令的抵抗力低于人类——一条"请编辑此列"的指令正是会被照做的指令（提示注入的良性近亲）。

**建议**：把表头改为中性表述（如 "Canonical role" / "Label in this repo"）并删除文末模板指令；或加一行注释说明该文件由哪个上游模板生成、何时本地化完成。

**第 2 轮状态**：❌ 未处理。

---

## 问题 15：缺少实现前必需的规格类文档（中）🟡 ADR 层大幅推进，三份 spec 仍缺

**相关文档**：[ADR-0014](../adr/0014-provide-final-json-and-streaming-ndjson.md)、[ADR-0018](../adr/0018-redact-evidence-before-it-enters-output-or-history.md)、[ADR-0019](../adr/0019-version-public-and-persisted-contracts-independently.md)

**现状（第 1 轮）**：项目只有词汇表和 ADR，四类内容无处归属：CLI 契约、Support Report 脱敏规则、数据目录布局（含日志保留）、Transaction Record schema 迁移策略。

**第 2 轮状态**：🟡 ADR 层大幅推进：

- **CLI 契约**：0006（修订）+ 0014 + 0019 已覆盖通道形态、错误分类学、独立版本化与迁移规则——ADR 能做的决策都做了；
- **Support Report 脱敏**：0018 的四级分类 + 统一 Redaction 模块 + "同一组敏感 fixture 覆盖每种输出形式"的测试要求，取代了原建议的独立字段清单文档的**决策部分**；
- **schema 迁移**：0019 明确"已知旧格式显式迁移，未知新格式只读并阻止变更"——正是原建议的策略。

**仍缺（实现第一个命令/第一个持久化文件之前需要）**：

1. **`docs/spec/cli-contract.md`**：每命令输入输出示例、phase code 与退出码的**数值表**（0014 定义了分类学但无数值）；
2. **`docs/spec/data-layout.md`**：目录布局、每个文件的创建权限数值（问题 3/4 剩余缺口的归属地）、日志保留时长与允许记录的内容级别；
3. **`docs/spec/record-schema.md`**：journal/Record 的字段结构，以及与 N2（轮转策略）一并定案的保留规则。

**理由**：ADR 回答"为什么这样做"，spec 回答"具体是什么"。当前 21 条 ADR 已把"为什么"推进得很完整，"是什么"的三份文档是下一阶段的自然产物，但应在写第一行实现代码之前出现，否则 spec 会退化成对实现的描述而不是对实现的约束。

---

## 附：评审覆盖范围声明

本评审只覆盖仓库内文档的一致性与完备性，未覆盖：

- ADR 中各技术事实的准确性（如 OpenSSH 行为细节、平台版本支持矩阵、`ssh -G` 对 `Match exec` 的求值行为）——这些需要在实现 spike 中验证；
- GitHub Issues 中的规格（`docs/agents/issue-tracker.md` 指向的 issue 无法从本地文档评审）；
- 未来 VS Code 扩展阶段（v0.3 之后）的设计——尚未存在。
