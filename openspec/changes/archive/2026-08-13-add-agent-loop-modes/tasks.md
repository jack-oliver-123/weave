## 1. 跨层契约与验收脚手架

- [x] 1.1 先为 `UserTurn.mode`、`TaskAction`、Plan/PlanStep、`AgentEvent`、`RunOutcome`、停止原因与 `ToolExecutor` 编写类型契约测试，再扩展 `src/shared/types.ts`，保持 shared 不依赖任何层实现。
- [x] 1.2 为 `taskId`、`runId`、`questionId`、`planId + version` 的关联与过期输入拒绝编写验收测试，并提供可注入的确定性 ID 生成器。
- [x] 1.3 为 AgentEvent 唯一 `run_stopped` 终态、终态后无迟到事件、迭代/步骤关联字段和“不含展示文案/内部推理”编写事件契约测试。

## 2. 最小提示词与控制工具协议

- [x] 2.1 先为基础、ReAct、Plan 规划和 Plan 执行提示词的必含/禁含片段编写测试，再实现纯函数 `PromptBuilder`，不引入权限、完整安全规则或终端文案。
- [x] 2.2 为 `submit_plan`、`complete_step`、`skip_step`、`complete_task`、`request_user_input`、`request_plan_revision` 编写中立定义、阶段可见性和 Schema 校验测试。
- [x] 2.3 实现 AgentLoop 私有控制工具目录与路由，确保控制工具不进入公共 `ToolRegistry`、不受业务工具开关影响、不能与业务调用混用且一次响应只能调用一个控制工具。
- [x] 2.4 为控制工具非法输入编写稳定错误观察与连续三次相同错误的无进展测试，确保失败不产生虚假状态迁移。

## 3. ToolExecutor 边界

- [x] 3.1 先为窄 `ToolExecutor` 的定义筛选、有序批次结果、统计和共享 `AbortSignal` 编写测试，再实现基于现有 `ToolRegistry` 与 `ToolCallScheduler` 的适配器。
- [x] 3.2 验证 ReAct/Plan 执行获得配置允许的完整业务工具，而 Plan 规划/完善只获得 `read_file`、`glob`、`grep`，写入与 Bash 定义不得进入请求。
- [x] 3.3 回归连续 `read_shared` 并发、`write_exclusive` 屏障、写入失败传播、32/100 调用限制、512 KiB 结果预算、取消收尾和原调用顺序。

## 4. AgentLoop ReAct 内核

- [x] 4.1 先为“模型响应 + 完整工具批次”迭代定义、业务失败反馈与下一轮调整编写 AgentLoop 单元测试，再实现不访问会话存储的私有运行历史。
- [x] 4.2 实现动态组合业务/控制工具、完整模型流组装、业务批次执行与控制工具处理，并通过结构化 AgentEvent 发布运行、迭代和工具生命周期。
- [x] 4.3 为工具前模型文本仅保留在私有协议历史、运行结束释放原始内部历史、RunOutcome 只返回必要摘要编写测试。
- [x] 4.4 实现 `complete_task` 唯一完成路径；为无业务工具首轮完成、普通文本协议纠正、禁止普通文本降级及达到业务调用上限后仅保留控制工具编写测试。
- [x] 4.5 实现 ReAct 10 次硬上限、不可恢复错误、共享取消与确定性停止摘要，确保上限后不再额外调用模型且终态后无迟到事件。
- [x] 4.6 实现稳定批次规范化与指纹；测试参数/结果变化重置计数、忽略耗时与时间戳、连续三次相同业务批次或控制错误以 `abnormal` 停止。
- [x] 4.7 实现 `request_user_input` 的结构化问题与 `awaiting_input` 终态，验证当前流结束后由新 `runId` 继续同一 `taskId`。

## 5. Plan 数据与状态机

- [x] 5.1 先为 Plan Schema、唯一步骤 ID、前序依赖、自/未知/后向/循环依赖拒绝和非空成功标准编写表驱动测试，再实现 Plan 校验器。
- [x] 5.2 先覆盖 `draft | awaiting_approval | executing | awaiting_input | awaiting_revision | cancelled | completed` 的合法与非法迁移，再实现封装不可变版本历史的 `PlanSession`。
- [x] 5.3 实现 `submit_plan` 首版与修订语义：保持 `planId`、递增 `version`、记录 `supersedesVersion`、保留有效完成步骤，并对失效步骤保存 `invalidated`、证据和原因。
- [x] 5.4 为 `planId + version` 审批绑定和过期审批拒绝编写测试；实现执行、继续完善、自由输入修订和退出的 PlanSession 动作。
- [x] 5.5 实现单个 AgentLoop 按数组顺序执行完整 Plan，每步复用 ReAct 子循环；测试每步 10 次、全计划 50 次、无并行步骤和跳过步骤阻断依赖者。
- [x] 5.6 实现并测试 `complete_step` 对逐项成功标准与 evidence 的校验、`skip_step` 理由保存，以及步骤失败后的自主重试、调整或跳过。
- [x] 5.7 实现 Plan `complete_task` 的有效步骤、步骤证据、任务级成功标准和任务级 evidence 校验，拒绝只凭步骤状态完成任务。
- [x] 5.8 实现 `request_plan_revision` 与执行中 `request_user_input` 的不同停止路径；验证实质变更必须重新规划审批，事实回答继续同一版本且无需重批。
- [x] 5.9 验证每次规划/继续完善最多 10 次、只读调查后必须 `submit_plan`、未提交达到上限时不生成可批准 Plan。

## 6. AgentTaskSession 与会话编排

- [x] 6.1 先覆盖 `running | awaiting_input | awaiting_approval | stopped | cancelled | completed | exited` 的合法迁移和与 PlanSession 的合法组合，再实现 `AgentTaskSession`。
- [x] 6.2 实现一个会话只允许一个未结束任务、每个顶层 ReAct 输入创建新任务、待回答普通输入绑定 `taskId + questionId`，并拒绝活动任务期间创建新 `/plan`。
- [x] 6.3 实现 `iteration_limit`/`abnormal` 后继续、补充要求或退出，以及取消后恢复；验证新运行重置单次预算但保留累计运行次数、总迭代数、进度与副作用摘要。
- [x] 6.4 实现 Plan 取消恢复前重新审批、执行问题回答后直接继续，以及退出任务释放活动状态并生成已完成工作、未完成项和副作用摘要。
- [x] 6.5 先为 AgentEvent 到 TurnEvent 的所有映射、关联标识、usage/计数汇总和唯一兼容终态编写测试，再收缩 `ConversationManager` 为上下文、任务路由、取消、映射与历史提交。
- [x] 6.6 移除 `ConversationManager` 内旧工具循环和纯文本直通路径；所有显式 ReAct/Plan 输入统一委托 AgentLoop，控制调用和内部文本不得写入 `ConversationStore`。
- [x] 6.7 扩展 `ConversationController` 的结构化任务 action 入口，并更新全部 fixture、live smoke 与调用方显式提交 `UserTurn.mode`，不得用 metadata 隐式编码审批或回答。

## 7. 三协议请求与闭环

- [x] 7.1 为 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 分别补充独立 `systemPrompt` 原生映射测试，确保提示词不进入普通历史消息。
- [x] 7.2 为三协议补充每请求动态组合业务与控制工具的编码测试，覆盖业务工具关闭仍提供控制工具、Plan 规划只读集合和 Provider 拒绝工具时不降级。
- [x] 7.3 扩展三协议伪流集成测试，分别完成 ReAct 业务工具结果回传、协议纠正、`complete_task`、`request_user_input` 与取消闭环。
- [x] 7.4 扩展三协议 Plan 伪流测试，覆盖 `submit_plan`、逐步执行、`complete_step`、任务级 `complete_task`、计划修订及私有/公共历史边界。
- [x] 7.5 保留真实 API AgentLoop smoke 为手动可选项，验证报告必须把未执行、Provider/平台失败和本地自动测试结果分开记录。

## 8. 单页 TUI Plan 交互

- [x] 8.1 先为普通输入显式 ReAct、`/plan <任务>` 解析、空命令用法和活动任务拒绝新 Plan 编写 reducer/集成测试，再实现命令路由。
- [x] 8.2 扩展 TUI 状态与转录块，紧凑展示 Plan 目标、任务级标准、步骤、依赖、步骤标准，以及恢复/修订时的状态和证据摘要。
- [x] 8.3 在唯一转录区末尾实现 `执行计划`、`继续完善`、`退出任务` 三个固定选项，不创建弹窗、独立页面、横向滚动或第二滚动区域。
- [x] 8.4 为等待审批且输入为空时 `Up/Down + Enter` 选项操作、输入非空时编辑/提交修订、普通状态不占用 Up 编写按键测试并实现路由。
- [x] 8.5 实现计划决策携带当前 `planId + version`、自由输入生成新版本、继续完善启动只读运行和过期审批重新展示最新版。
- [x] 8.6 实现 `stopped` 的继续/补充要求/退出、`cancelled` 的恢复/退出，以及 Plan 恢复前重新确认；展示累计运行与迭代统计。
- [x] 8.7 回归 FIFO 生成队列、Ctrl+C、Ctrl+Z、Markdown、真实光标、唯一滚动区域、窄终端布局和 Windows/WSL 输入约束。

## 9. 装配、回归与验收

- [x] 9.1 更新应用入口，按业务工具开关装配可选 ToolExecutor，但始终装配 AgentLoop 控制工具、PromptBuilder、任务状态机和统一 ConversationManager 路径。
- [x] 9.2 运行 AgentLoop、控制工具、PlanSession、AgentTaskSession、ToolExecutor、ConversationManager、三协议和 TUI 分组测试并分别记录结果。
- [x] 9.3 运行 `npm run typecheck`、`npm run build`、`npm test` 与 `npm run spec:validate`，修复所有回归、警告和可修复证据缺口。
- [x] 9.4 运行 `npm run docs:link`、WIKI 同步与 `npm run docs:build`，验证 active 页面 include、导航、单页文档和 OpenSpec 链接一致。
- [x] 9.5 执行人工终端 smoke：默认 ReAct、`/plan` 规划/完善/修订/审批/执行、请求输入、迭代停止、取消恢复和单滚动区域；分别记录经典 Console Host 与 Windows Terminal 可验证范围。
- [x] 9.6 输出最终验收矩阵，分别标注 focused tests、全套测试、构建、OpenSpec、文档、人工终端、真实 API smoke 与任何外部未验证门槛。
- [x] 9.7 先为 ReAct 就绪/运行、Plan 规划/待确认/执行进度/暂停状态和结束回落编写 reducer 与 view 验收测试。
- [x] 9.8 在交互层从结构化 `UserTurn.mode`、`TaskAction` 和 `TurnEvent` 投影当前模式与阶段，状态栏持续显示且不增加第二滚动区域。
- [x] 9.9 运行 focused tests、全套测试、类型检查、构建与 OpenSpec 严格校验，更新验收矩阵。
