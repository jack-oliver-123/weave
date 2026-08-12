## Context

见 `proposal.md` 的 Why。仓库是 Node.js 22+、npm 锁文件驱动的 TypeScript 项目，已有 `typecheck`、`test`、`build`、`docs:link` 与 `docs:build` 脚本，但没有 `.github/workflows`。OpenSpec CLI 目前由开发机全局提供，远程仓库也没有可作为分支保护依据的检查状态。

该变更横跨本地依赖契约、GitHub Actions 和 GitHub 仓库规则。工作流文件可以随代码提交，仓库合并策略与 `main` 规则则必须在 GitHub 远端配置；后者只有在首次工作流运行产生 `CI Gate` 状态后才能可靠绑定并验证。

## Goals / Non-Goals

**Goals:**

- 让本地与 CI 使用同一套锁定依赖和 OpenSpec 校验命令。
- 在失败时快速指出代码质量、测试、文档或规格问题，同时向分支规则暴露一个长期稳定的汇总检查名。
- 用最小 GitHub token 权限和不可变 Action 引用降低 CI 供应链风险。
- 让仓库设置可通过 API 回读，证明门禁已实际应用而不只是写入计划。

**Non-Goals:**

- 不在首版建立跨操作系统测试矩阵，也不运行需要 Windows、WSL、终端复用器或付费 LLM 凭据的检查。
- 不引入覆盖率阈值、依赖漏洞阻断、自动重试或 Merge Queue。
- 不强制所有 Pull Request 创建 OpenSpec 变更，也不要求人工审批人数。
- 不修改产品运行时行为。

## Decisions

### 1. 使用单个工作流和三个并行验证任务

工作流在 `pull_request`（目标为 `main`）与 `push`（分支为 `main`）上触发，不设置 `paths` 或 `paths-ignore`。`Code Quality` 执行类型检查和生产构建，`Tests` 执行完整测试，`Docs & OpenSpec` 建立文档链接、构建文档并运行严格规格校验。三个任务均使用 `ubuntu-latest`、Node.js 22.x、`npm ci` 和 15 分钟超时。

每个任务独立执行 `npm ci`，会增加少量安装时间，但隔离了任务状态、允许并行运行，并使失败归属清晰。相较于一个串行任务，这种结构能更早返回反馈；相较于首版操作系统矩阵，它不引入尚未稳定的环境成本。

### 2. 用显式汇总任务提供稳定的 `CI Gate`

`CI Gate` 依赖三个验证任务，并使用始终求值的条件检查所有 `needs.*.result` 是否均为 `success`。这样上游失败或取消时汇总任务仍能给出明确的非成功状态，分支规则只需绑定一个稳定名称，未来内部任务拆分不会迫使修改保护规则。

不直接把三个内部任务都设为 required checks，因为任务重命名或重组容易导致仓库规则引用陈旧状态；也不把所有命令压入单个任务，因为那会牺牲并行速度和诊断能力。

### 3. 将 OpenSpec CLI 纳入锁文件

在 `devDependencies` 中精确固定 `@fission-ai/openspec` 版本 `1.7.0`，新增 `spec:validate` 脚本执行 `openspec validate --all --strict --no-interactive`。npm 脚本会优先解析项目本地二进制，使开发机与 CI 复现同一版本和参数。

选择全量严格校验而不是只验证活动变更，以同时保护主规格和归档；选择非交互模式以避免 runner 等待输入。校验不检查“每个 PR 是否新增变更”，因为这属于变更分类和审查决策，不应通过空规格机械满足。

### 4. 在全新 runner 上显式建立文档链接

`docs/openspec` 不是普通受版本控制目录，文档构建前执行现有 `npm run docs:link`，由脚本在 Ubuntu 创建指向根目录 `openspec` 的链接，再执行 `npm run docs:build`。这模拟干净 checkout，避免依赖开发机已有的 Windows junction。

### 5. 最小权限与并发取消在工作流顶层统一声明

工作流顶层设置 `permissions: contents: read`，不声明 secrets；所有 `uses:` 引用固定到完整 commit SHA。`concurrency` 按工作流及 PR 编号或 Git 引用分组，并启用 `cancel-in-progress`，确保新提交取代同一候选分支的旧结果，同时不同 Pull Request 互不取消。

首版不加入自动重试。偶发失败应暴露并被调查，而不是由重试掩盖；需要重跑时由维护者显式触发。

### 6. 使用 GitHub 规则强制 Pull Request 与最新汇总状态

在工作流首次成功运行并出现 `CI Gate` 后，为 `main` 配置无 bypass actor 的活动规则：要求 Pull Request、要求 `CI Gate`、启用 strict/up-to-date、要求解决 Review 对话、审批人数为 0、禁止强推和删除。仓库级合并设置只保留 squash merge，并启用合并后删除来源分支；Merge Queue 保持关闭。

优先使用 GitHub Rulesets 表达“管理员同样受约束”和无绕过主体；若仓库能力只能使用经典分支保护，则必须配置等价的 enforce-admins 与限制，并通过 API 回读确认。不会把“配置请求返回成功”当作门禁已生效的充分证据。

## Risks / Trade-offs

- [三个任务分别安装依赖会增加总计算量] → 利用 npm 缓存，并以并行执行换取更短反馈时间和更清晰诊断。
- [Node.js 22.x 会随补丁版本更新] → 主版本与项目契约一致，锁文件固定依赖；接受 LTS 安全补丁带来的小范围变化。
- [固定 Action SHA 降低自动升级速度] → 通过明确的依赖维护变更审查并更新 SHA。
- [`main` 更新会使已通过的 Pull Request 重新排队] → 接受额外运行成本，以验证候选分支与最新主分支的组合。
- [GitHub 设置不在 Git 历史中自动应用] → 在任务中包含精确配置、API 回读和实际阻断验证，并分别报告工作流代码与远端规则状态。
- [Ubuntu 门禁不能证明 Windows/WSL TUI 行为] → 在 CI 结果和交付报告中保持验证边界，后续以独立变更加入稳定的跨平台任务。
- [管理员也不可绕过可能增加紧急修复时间] → 紧急修复仍走最小 PR 和同一 `CI Gate`，以一致性换取更强保护。

## Migration Plan

1. 添加固定版本 OpenSpec 开发依赖与 `spec:validate` 脚本，更新锁文件并在本地验证安装和校验。
2. 添加 CI 工作流，在功能分支运行全部任务，确认 `CI Gate` 对成功和失败依赖均正确汇总。
3. 提交并推送变更，通过 Pull Request 让 GitHub 首次登记 `CI Gate` 检查名称。
4. 在用户明确授权远端配置后，设置仓库合并策略与 `main` 规则，并通过 GitHub API 回读全部字段。
5. 使用最新 PR head 验证 `CI Gate` 和合并阻断行为；合并后确认 `main` push CI 成功及来源分支自动删除。

若工作流导致仓库无法正常贡献，可通过新的受控变更先修复工作流；若远端规则配置错误，则由仓库管理员通过 GitHub 设置/API 精确修正规则，而不删除或放宽无关保护。任何临时放宽都必须单独获得授权并在修复后回读恢复状态。
