## Purpose

定义 Weave 仓库中 OpenSpec 与工程 Skills 的统一协作方式，使 Agent 从需求澄清到实现验证始终使用单一规格源，并遵守明确的人工授权边界。

## ADDED Requirements

### Requirement: 变更必须进入唯一工作流
工程 Agent MUST 在修改功能、Bug、配置或文档前，根据项目工作流把变更分类为 `quick`、`standard` 或 `large`。`standard` 与 `large` 变更 MUST 使用 OpenSpec artifacts 作为唯一规格源；`/to-spec` 只可用于明确不采用 OpenSpec 的 `quick` 任务。

#### Scenario: 标准变更进入 OpenSpec
- **WHEN** 用户请求会改变共享工作流、公共契约或多个 module 的变更
- **THEN** Agent 将其分类为 `standard` 并进入 OpenSpec Explore/Propose 流程
- **THEN** Agent 不创建第二份 `/to-spec` 规格

#### Scenario: 轻量变更使用工程原语
- **WHEN** 任务满足项目定义的全部 `quick` 条件且没有活动 OpenSpec change
- **THEN** Agent 可以直接使用 TDD 与 code-review
- **THEN** 只有在需要 Issue 跟踪且用户明确调用时才使用 `/to-spec`

### Requirement: 路由 Skill 必须组合而不是取代 OpenSpec
工程 Skill 路由 MUST 读取项目的 OpenSpec 工作流，并把 grilling、research、prototype、Wayfinder、TDD 与 code-review 作为可组合原语。对于采用 OpenSpec 的工作，路由 MUST 使用 OpenSpec Propose、Apply、Verify、spec sync 与 archive 生命周期。

#### Scenario: 大型变更完成决策后进入 OpenSpec
- **WHEN** Wayfinder 已消除大型工作的关键未知项
- **THEN** 路由将决策输入 OpenSpec Propose
- **THEN** 路由从 OpenSpec tasks 生成 tracer-bullet Tickets

#### Scenario: OpenSpec 工作进入实施
- **WHEN** 用户要求实施已有 OpenSpec change
- **THEN** 实施入口委派给 OpenSpec Apply
- **THEN** Apply 使用 OpenSpec contextFiles、任务状态和 Issue frontier 作为控制输入

### Requirement: 实施入口必须执行分层验证
采用 OpenSpec 的实施工作 MUST 按项目工作流执行 TDD、code-review 和 OpenSpec Verify。非 OpenSpec 的 `quick` 工作 MUST 至少执行 focused tests、code-review 与适用的完整质量门禁。

#### Scenario: OpenSpec 实施完成
- **WHEN** 一个 OpenSpec change 的实现 tasks 全部完成
- **THEN** Agent 从实现前的 fixed point 运行 Standards 与 Spec code-review
- **THEN** review 收敛后运行 OpenSpec Verify
- **THEN** 只有 Verify 通过后才建议 spec sync 与 archive

#### Scenario: Quick 实施完成
- **WHEN** 一个不采用 OpenSpec 的 `quick` 任务实现完成
- **THEN** Agent 运行 focused tests、code-review 和适用的完整质量门禁
- **THEN** Agent 报告验证证据而不声称执行了 OpenSpec Verify

### Requirement: 发布动作必须保持独立授权
工程 Skills MUST 将 Issue 创建或关闭、commit、push、PR 创建、merge、spec sync 与 archive 视为相互独立的授权动作。实现完成 MUST NOT 自动执行这些动作。

#### Scenario: 实现完成但没有提交授权
- **WHEN** Agent 已完成代码与验证而用户没有明确授权 commit
- **THEN** Agent 保留工作区改动并报告验证结果
- **THEN** Agent 不创建 commit

#### Scenario: 已授权实现但未授权远程操作
- **WHEN** 用户只授权本地修复
- **THEN** Agent 不创建或关闭 Issue，不 push、不创建 PR 且不 merge

### Requirement: 多 Agent Skill 副本必须保持同一契约
仓库中供不同 Agent host 使用的工程 Skill 副本 MUST 对 OpenSpec 路由、验证顺序和授权边界表达相同语义。自动化检查 MUST 在副本漂移或关键契约缺失时失败。

#### Scenario: Skill 副本发生漂移
- **WHEN** `.agents` 与 `.claude` 中受管 Skill 的正文不一致
- **THEN** 工程 Skill 契约检查失败并指出发生漂移的 Skill

#### Scenario: 上游更新恢复冲突行为
- **WHEN** Skill 更新重新引入 `/to-spec` 取代 OpenSpec 或自动 commit 行为
- **THEN** 工程 Skill 契约检查失败
