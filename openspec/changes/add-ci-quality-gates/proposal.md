## Why

仓库当前没有远程 CI 检查，Pull Request 即使缺少类型检查、测试、构建、文档或 OpenSpec 校验结果，也可能进入 `main`。现在需要建立可重复、不可绕过的质量门禁，让每个候选提交和合并后的真实提交都有明确验证证据。

## What Changes

- 新增 GitHub Actions CI，在所有指向 `main` 的 Pull Request 及 `main` push 上运行，并取消同一引用上已过时的执行。
- 将代码质量、完整测试、文档与 OpenSpec 校验拆为并行任务，并提供稳定的汇总状态 `CI Gate`。
- 统一 Node.js 22.x、`npm ci`、项目构建与测试命令，并将 OpenSpec CLI 1.7.0 锁定为项目开发依赖。
- 配置 `main` 规则：强制通过 Pull Request 合并、要求最新分支上的 `CI Gate`、解决全部 Review 对话，并禁止管理员绕过、直接推送、强制推送和删除。
- 仓库只允许 squash merge，合并后自动删除功能分支；首版不启用人工审批人数、Merge Queue、覆盖率阈值、依赖漏洞必过检查、自动重试或依赖真实 LLM/Windows/WSL 环境的测试。

## Capabilities

### New Capabilities

- `continuous-integration-quality-gates`: 定义面向 `main` 的 CI 触发、可复现的并行检查、稳定汇总门禁及仓库合并保护行为。

### Modified Capabilities

无。

## Impact

- 新增 `.github/workflows/` 下的 CI 工作流。
- 修改 `package.json` 与 `package-lock.json`，加入固定版本的 `@fission-ai/openspec` 和统一的 OpenSpec 校验脚本。
- 修改 GitHub 仓库设置与 `main` 分支规则；这些远端设置需要在工作流首次成功产生 `CI Gate` 后配置并回读验证。
- 不修改 Weave 运行时 API、TUI 行为或生产依赖，不使用任何 CI 密钥。
