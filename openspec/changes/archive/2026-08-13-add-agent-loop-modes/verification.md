# 验收矩阵

| 门槛 | 状态 | 证据 |
| --- | --- | --- |
| AgentLoop / 控制工具 / PlanSession / AgentTaskSession / ToolExecutor / ConversationManager focused tests | 通过 | `npm test` 中对应 unit 与 integration 分组通过 |
| Plan 停止恢复与补充修订 | 通过 | 草拟超限后继续保持 `plan_draft`；执行停止后补充要求生成同 `planId` 的新版本并重新审批 |
| 确定性进度与副作用摘要 | 通过 | `RunOutcome.progress`、跨运行累计、停止摘要和退出历史的 focused / integration 测试通过 |
| Plan 步骤失败事件 | 通过 | 步骤达到硬上限或运行异常时发布 `plan_step_failed`，保存失败原因并允许后续重试或修订 |
| 暂停终态统计 | 通过 | `awaiting_input` 与 `plan_revision` 的 `turn_complete` 均保留真实 usage 与运行计数 |
| 三协议 ReAct 控制、取消与业务工具闭环 | 通过 | `multi-protocol-tool-loop.test.ts`、`multi-protocol-control-loop.test.ts` |
| 三协议 Plan 提交、步骤、完成与修订闭环 | 通过 | `multi-protocol-plan-loop.test.ts` |
| TUI 命令、选项、模式标识、单滚动区与既有交互回归 | 通过 | `tui-interaction.test.tsx`、`tui-reducer.test.ts` 与 `weave-view.test.tsx`；状态栏持续显示 ReAct/Plan 及 Plan 阶段，临时状态仅作后缀 |
| Windows CMD / PowerShell 自动终端 E2E | 通过 | `npm run e2e:tui:windows`，psmux 100x30 与 79x23 场景通过 |
| 全套测试 | 通过 | 43 个测试文件、284 个测试通过 |
| TypeScript 类型检查 | 通过 | `npm run typecheck` |
| 应用构建 | 通过 | `npm run build` |
| OpenSpec 严格校验 | 通过 | `npm run spec:validate`，8 项通过 |
| WIKI 链接与文档构建 | 通过 | `npm run docs:link`、`npm run docs:build` |
| 人工终端 smoke | 通过 | 2026-08-13 在经典 Console Host 与 Windows Terminal 的独立可见窗口中，逐步操作并检查确定性 AgentLoop fixture；截图保存于 `.artifacts/agent-loop-terminal-smoke/` |
| 真实 API AgentLoop smoke | 未执行 | 手动可选；本次未使用真实 Provider 凭据，不把本地伪流结果等同于真实 API 证明 |

## 外部门槛

- 未验证真实 Provider 对当前最小 System Prompt 与私有控制工具的实际遵循稳定性。

## 人工终端 smoke 记录

- 经典 Console Host：默认 ReAct 完成；Plan v1 规划、继续完善到 v2、用户补充修订到 v3、审批与执行完成；请求输入后恢复；10 次迭代上限后继续；`Ctrl+C` 取消后恢复；单会话内容滚动区域、固定输入框与状态栏可见且稳定。
- Windows Terminal：重复上述全部流程并通过；中文文案、选项切换、长进度摘要、内容滚动、输入框和状态栏渲染正常，未出现第二个应用内滚动容器。
- 模式标识补充 smoke：Windows Terminal 实际可见窗口确认初始 `ReAct · 就绪` 和计划生成后 `Plan · 待确认`，仍复用原单行状态栏与单滚动区；截图为 `.artifacts/agent-loop-terminal-smoke/mode-00-react-ready.png` 与 `mode-02-plan-awaiting.png`。瞬时 `Plan · 规划中` 由组件测试验证，不冒充人眼捕获证据。
- 该 smoke 使用真实 `ConversationManager`、`AgentLoop` 和 TUI，使用确定性 LLM/ToolExecutor fixture 隔离 Provider 网络波动；因此它验证本地交互与运行时契约，不代表真实 API smoke。
