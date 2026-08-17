## Context

见 `proposal.md`。仓库同时维护 Matt Pocock 工程 Skills 与 OpenSpec Skills，并通过 `docs/agents/openspec-workflow.md` 定义两者的项目级责任边界。当前冲突位于用户可直接调用的路由与实施入口；同一 Skill 还分别存在于 `.agents` 和 `.claude`，因此上游更新或单边编辑可能重新引入漂移。

## Goals / Non-Goals

**Goals:**

- 让用户从 `ask-matt` 或 `implement` 进入时也遵循项目的 OpenSpec 工作流。
- 让项目工作流保持唯一权威，Skill 只保留短路由和明确的完成条件。
- 用快速、确定性的文本契约检查保护多 host 副本和关键授权规则。

**Non-Goals:**

- 不实现 Weave 产品自身的 Skill discovery、registry、解析或执行运行时。
- 不修改 OpenSpec CLI 或 Matt Pocock 上游仓库。
- 不在本 change 中执行 Issue、commit、push、PR、merge、spec sync 或 archive。

## Decisions

### 1. 项目工作流是唯一权威

`ask-matt` 和 `implement` 在仓库内先读取 `docs/agents/openspec-workflow.md`，然后只描述各自的路由职责。选择这一方式是为了避免复制 quick/standard/large 判定和 Apply/Review 细节。备选方案是在两个 Skill 中重复完整规则，但会制造三个需要同步的事实源。

### 2. `ask-matt` 负责路由，OpenSpec 负责规格生命周期

`ask-matt` 保留 grilling、prototype、research 与 Wayfinder 入口；一旦任务进入 `standard` 或 `large`，就切换到 OpenSpec Propose，再从 OpenSpec tasks 生成 Tickets。`/to-spec` 只保留给非 OpenSpec quick 工作。这样保留 Matt Skills 的组合价值，同时避免双规格。

### 3. `implement` 只编排已有权威流程

当输入来自 OpenSpec change 或映射到 OpenSpec task 的 Ticket 时，`implement` 委派给 OpenSpec Apply，并在 Apply 规定的 TDD、code-review 与 Verify 流程收敛后停止。其他输入仅按 quick 流程执行。Skill 不再自动 commit，因为 commit 是项目明确规定的独立授权动作。

### 4. 契约测试覆盖语义和副本一致性

新增 Node 契约测试读取 Skill Markdown，验证 `.agents`/`.claude` 副本一致、OpenSpec 路由存在、`/to-spec` 受到 quick 限制，以及自动 commit 指令不存在。测试接入现有 `npm test` 的 CI 契约阶段。选择文本契约而非 Markdown AST，是因为被保护的是少量稳定语句与副本一致性，失败信息可以保持直接。

## Risks / Trade-offs

- [Matt Skills 上游更新覆盖本地适配] -> CI 契约测试在合并前阻止冲突重新进入。
- [文本检查对措辞变化敏感] -> 只匹配稳定的 Skill 名称、权威文档路径与禁止的自动提交语义，不锁定整段文案。
- [双副本增加维护成本] -> 本次先用一致性检查保护现状；目录统一属于独立结构变更。

## Migration Plan

1. 先提交失败的工程 Skill 契约测试，证明当前路由与授权冲突。
2. 同步修改 `.agents` 与 `.claude` 的 `ask-matt`、`implement`。
3. 运行聚焦契约测试、完整测试、类型检查、构建与严格 OpenSpec 校验。
4. 若需回滚，恢复四个 Skill 文件和对应契约测试；不涉及运行时数据迁移。
