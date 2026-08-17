## Why

当前仓库级工作流已经声明 OpenSpec 是标准与大型变更的唯一规格源，但 `ask-matt` 仍把多会话工作导向 `/to-spec`，`implement` 仍会绕过 OpenSpec Apply/Verify 并自动提交。这些入口冲突会让同一变更产生两份规格，或越过项目要求的验证与授权边界。

## What Changes

- 为工程 Agent 定义统一的 `quick`、`standard`、`large` 路由，标准与大型变更进入 OpenSpec，只有轻量且不采用 OpenSpec 的任务可以使用 `/to-spec`。
- 让 `ask-matt` 在仓库中先读取项目工作流，再把探索、原型、Wayfinder、OpenSpec 和 Ticket Skills 组合成单一主流程。
- 让 `implement` 对 OpenSpec 工作委派给 OpenSpec Apply，并在实现后执行 code-review 与 OpenSpec Verify；非 OpenSpec 的 quick 工作仍使用 TDD 和 code-review。
- 删除 `implement` 的自动 commit 行为，保留 Issue 状态、commit、push、PR、merge、spec sync 与 archive 的独立授权。
- 为 `.agents` 与 `.claude` 中的 Skill 副本增加一致性和关键路由契约检查，防止后续上游更新恢复冲突。

## Capabilities

### New Capabilities

- `engineering-agent-workflow`: 规定 OpenSpec 与工程 Skills 的路由、实施、验证和授权边界。

### Modified Capabilities

## Impact

- 影响 `.agents/skills/ask-matt`、`.agents/skills/implement` 及其 `.claude/skills` 副本。
- 增加只验证 Skill 文本契约的 CI 测试，不改变 Weave 产品运行时代码或公开 API。
- 不实现 Weave 自身的 Skill discovery、registry 或 runtime。
