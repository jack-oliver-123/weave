## 1. 实施准备与验收基线

- [x] 1.1 确认工作区没有会与本变更冲突的用户修改，并从最新 `main` 创建不以 `codex` 开头的 `feat/add-ci-quality-gates` 分支
- [x] 1.2 为 CI 工作流建立静态验收检查，覆盖触发范围、无路径过滤、并发取消、只读权限、完整 SHA 引用、三个并行任务、15 分钟超时及稳定的 `CI Gate`
- [x] 1.3 记录当前 `npm ci`、类型检查、完整测试、生产构建、文档构建和 OpenSpec 严格校验基线，区分已有失败与本变更回归

## 2. 本地依赖与统一命令

- [x] 2.1 将 `@fission-ai/openspec` 精确版本 1.7.0 加入 `devDependencies`，并通过 npm 更新 `package-lock.json`
- [x] 2.2 在 `package.json` 新增 `spec:validate`，执行 `openspec validate --all --strict --no-interactive`
- [x] 2.3 从干净依赖安装验证 `npm ci` 不修改锁文件，且 `npm run spec:validate` 使用项目锁定版本并成功校验全部现有产物

## 3. GitHub Actions 工作流

- [x] 3.1 新增面向 `main` Pull Request 与 `main` push 的 CI 工作流，不配置路径过滤，并按 Pull Request 或 Git 引用取消过时运行
- [x] 3.2 配置顶层 `contents: read` 最小权限、Node.js 22.x、npm 缓存，并将所有 Action 固定到经核验的完整 commit SHA
- [x] 3.3 实现 `Code Quality` 任务，以 `npm ci` 安装依赖并依次运行类型检查与生产构建，设置 15 分钟超时且不自动重试
- [x] 3.4 实现 `Tests` 任务，以 `npm ci` 安装依赖并运行完整测试套件，设置 15 分钟超时且不自动重试
- [x] 3.5 实现 `Docs & OpenSpec` 任务，以 `npm ci` 安装依赖，建立 `docs/openspec` 链接，构建文档并运行统一 OpenSpec 严格校验，设置 15 分钟超时且不自动重试
- [x] 3.6 实现始终求值的 `CI Gate` 汇总任务，仅在三个依赖任务结果全部为 `success` 时成功，并确保工作流不声明或读取任何 secrets

## 4. 本地验证

- [x] 4.1 运行工作流静态验收检查，确认 YAML 语法、任务依赖、检查显示名和安全约束均符合 delta spec
- [x] 4.2 依次运行 `npm ci`、`npm run typecheck`、`npm test`、`npm run build`、`npm run docs:link`、`npm run docs:build` 与 `npm run spec:validate`
- [x] 4.3 验证首版工作流未加入 Windows/WSL TUI E2E、真实 LLM API smoke、覆盖率阈值、依赖漏洞阻断、自动重试或 Merge Queue
- [x] 4.4 运行 `openspec validate add-ci-quality-gates --strict --no-interactive`，并复核实现、任务完成状态与 delta spec 一致

## 5. 远程 CI 与仓库门禁

- [x] 5.1 在获得提交和推送授权后，以明确路径暂存本变更、提交并推送功能分支；在单独获得 PR 创建授权后创建指向 `main` 的 Pull Request
- [ ] 5.2 验证 Pull Request 最新 head 上 `Code Quality`、`Tests`、`Docs & OpenSpec` 与 `CI Gate` 的真实 GitHub Actions 结果，并确认同一 PR 的旧运行会被新提交取消
- [ ] 5.3 在获得远端仓库配置授权后，只保留 squash merge、禁用 merge commit 与 rebase merge、启用合并后自动删除来源分支，并保持 Merge Queue 关闭
- [ ] 5.4 配置无绕过主体的 `main` 规则，要求 Pull Request、最新 `main` 上成功的 `CI Gate` 和全部 Review 对话已解决，审批人数设为 0，并禁止直接推送、强推和删除
- [ ] 5.5 通过 GitHub API 回读仓库合并设置及 `main` 全部规则字段，并用未满足门禁的测试分支验证操作会被拒绝；不得仅依据配置请求成功声明门禁已生效
- [ ] 5.6 在获得合并授权后仅合并已验证的最新 PR head，确认 squash 提交触发 `main` push CI、`CI Gate` 成功且来源分支自动删除；未获得授权时明确保留为未执行远端验收
