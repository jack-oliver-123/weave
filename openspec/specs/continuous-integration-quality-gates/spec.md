# continuous-integration-quality-gates Specification

## Purpose

定义 Weave 仓库对 Pull Request 与 `main` 合并提交执行的持续集成质量检查、稳定汇总状态及不可绕过的合并保护，确保进入主分支的变更具有一致且可追溯的验证证据。

## Requirements

### Requirement: 对主分支候选变更和合并结果运行 CI
仓库 SHALL 对每个以 `main` 为目标分支的 Pull Request 以及每次 `main` push 运行完整 CI，且 SHALL 不使用路径过滤跳过检查。同一工作流与 Git 引用出现更新提交时，系统 SHALL 取消该引用上仍在执行的旧运行。

#### Scenario: Pull Request 触发检查
- **WHEN** Pull Request 以 `main` 为目标分支被创建、重新打开、同步或提交新修改
- **THEN** 系统对最新候选提交启动完整 CI

#### Scenario: 合并提交触发检查
- **WHEN** 合并结果被推送到 `main`
- **THEN** 系统对该 `main` 提交再次启动完整 CI

#### Scenario: 新提交取代旧运行
- **WHEN** 同一 Pull Request 在旧 CI 尚未结束时推送新提交
- **THEN** 系统取消旧运行并仅以新提交的结果作为当前证据

#### Scenario: 任意路径变更均不绕过门禁
- **WHEN** 候选提交只修改文档、配置或其他非源码路径
- **THEN** 系统仍运行完整 CI

### Requirement: 以可复现的并行任务验证仓库
CI SHALL 在 `ubuntu-latest` 上使用 Node.js 22.x，并 SHALL 在每个任务中通过 `npm ci` 从已提交的锁文件安装依赖。CI SHALL 并行执行 `Code Quality`、`Tests`、`Docs & OpenSpec` 三个任务，每个任务 SHALL 在 15 分钟后超时失败且 SHALL 不自动重试失败命令。

#### Scenario: 依赖声明与锁文件不一致
- **WHEN** `package.json` 与 `package-lock.json` 无法由 `npm ci` 一致安装
- **THEN** 受影响任务失败且 CI 不修改锁文件

#### Scenario: 代码质量检查通过
- **WHEN** 类型检查与生产构建均成功
- **THEN** `Code Quality` 任务通过

#### Scenario: 完整测试通过
- **WHEN** 仓库完整自动化测试套件成功
- **THEN** `Tests` 任务通过

#### Scenario: 文档与 OpenSpec 检查通过
- **WHEN** 全新 runner 建立 `docs/openspec` 链接后文档构建成功，且全部 OpenSpec 主规格、活动变更与归档内容通过严格非交互校验
- **THEN** `Docs & OpenSpec` 任务通过

#### Scenario: 任务执行超时
- **WHEN** 任一并行任务运行超过 15 分钟
- **THEN** 该任务终止并失败，系统不自动重试

### Requirement: 固定 OpenSpec 校验契约
项目 SHALL 将 `@fission-ai/openspec` 1.7.0 固定为开发依赖，并 SHALL 提供本地与 CI 共用的 `spec:validate` 脚本，以执行 `openspec validate --all --strict --no-interactive`。该校验 SHALL 验证已有 OpenSpec 产物，但 SHALL 不要求每个 Pull Request 都新增 OpenSpec 变更。

#### Scenario: OpenSpec 产物合法
- **WHEN** 所有已有主规格、活动变更与归档内容均通过 OpenSpec 1.7.0 严格校验
- **THEN** `spec:validate` 以成功状态结束

#### Scenario: 任一 OpenSpec 产物不合法
- **WHEN** 任一已有 OpenSpec 产物未通过严格校验
- **THEN** `spec:validate` 以非零状态结束并阻止 `Docs & OpenSpec` 任务通过

#### Scenario: 不涉及规格的变更
- **WHEN** Pull Request 没有新增 OpenSpec 变更但仓库中已有产物均合法
- **THEN** OpenSpec 门禁允许通过

### Requirement: 提供稳定的汇总门禁
CI SHALL 提供名为 `CI Gate` 的稳定汇总检查。只有 `Code Quality`、`Tests`、`Docs & OpenSpec` 全部成功时，`CI Gate` 才 SHALL 成功；任一依赖任务失败、取消或未成功完成时，`CI Gate` SHALL 不成功。

#### Scenario: 所有依赖任务成功
- **WHEN** 三个并行任务全部成功完成
- **THEN** `CI Gate` 成功

#### Scenario: 任一依赖任务未成功
- **WHEN** 任一并行任务失败、取消或未成功完成
- **THEN** `CI Gate` 不成功并阻止合并

### Requirement: 以最小权限执行基础门禁
CI SHALL 将默认 GitHub token 权限限制为只读仓库内容，SHALL 将使用的 GitHub Actions 固定到完整 commit SHA，且 SHALL 不向基础门禁提供仓库密钥或真实 LLM 凭据。

#### Scenario: 基础门禁运行
- **WHEN** 任一受支持事件触发 CI
- **THEN** 工作流只获得读取仓库内容所需权限且不读取任何仓库密钥

#### Scenario: 外部 Action 被引用
- **WHEN** 工作流使用 GitHub 或第三方 Action
- **THEN** 引用使用完整 commit SHA 而不是可变标签

### Requirement: 保护 main 分支合并路径
仓库 SHALL 要求所有进入 `main` 的变更通过 Pull Request，并 SHALL 要求候选分支基于最新 `main` 的 `CI Gate` 成功。仓库 SHALL 要求全部 Review 对话已解决，但 SHALL 不要求最低人工审批人数。管理员 SHALL 不得绕过这些规则，且 `main` SHALL 禁止直接推送、强制推送和删除。

#### Scenario: 候选提交未通过汇总门禁
- **WHEN** Pull Request 的最新候选提交没有成功的 `CI Gate`
- **THEN** 仓库拒绝合并

#### Scenario: main 已在检查后更新
- **WHEN** Pull Request 曾通过 `CI Gate` 但 `main` 随后出现新提交
- **THEN** 仓库要求候选分支同步最新 `main` 并重新通过 `CI Gate`

#### Scenario: Review 对话未解决
- **WHEN** Pull Request 仍有未解决的 Review 对话
- **THEN** 仓库拒绝合并

#### Scenario: 没有人工审批
- **WHEN** `CI Gate` 已通过、候选分支为最新且所有 Review 对话已解决，但没有审批记录
- **THEN** 最低审批人数规则不阻止合并

#### Scenario: 管理员尝试绕过保护
- **WHEN** 仓库管理员尝试在不满足 Pull Request 门禁时更新 `main`
- **THEN** 仓库执行相同保护并拒绝操作

#### Scenario: 尝试强推或删除 main
- **WHEN** 任意身份尝试强制推送或删除 `main`
- **THEN** 仓库拒绝操作

### Requirement: 保持单一合并历史策略
仓库 SHALL 只允许 squash merge，SHALL 禁用 merge commit 与 rebase merge，并 SHALL 在 Pull Request 合并后自动删除来源分支。首版 SHALL 不启用 Merge Queue。

#### Scenario: 合并符合门禁的 Pull Request
- **WHEN** Pull Request 满足全部 `main` 保护规则并被合并
- **THEN** GitHub 以 squash merge 写入 `main` 并自动删除来源分支

#### Scenario: 请求其他合并方式
- **WHEN** 用户尝试使用 merge commit 或 rebase merge 合并
- **THEN** 仓库不提供该合并方式

### Requirement: 将环境相关与策略未定检查排除在首版必过门禁外
首版必过门禁 SHALL 不运行 Windows/WSL TUI E2E、真实 LLM API smoke、覆盖率阈值或依赖漏洞阻断检查。这些检查的缺失 SHALL 明确表示未由首版 CI 验证，不得被报告为已经通过。

#### Scenario: 基础门禁全部通过
- **WHEN** `CI Gate` 成功
- **THEN** 结果仅证明已配置的 Ubuntu 代码质量、完整测试、文档与 OpenSpec 检查通过，不证明环境相关 E2E、真实 API、覆盖率或漏洞扫描通过
