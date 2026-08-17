# agent-task-execution Specification

## Purpose

定义 Weave 如何以独立、可观察且有界的 AgentLoop 运行 ReAct 与 Plan 任务，并通过结构化计划、控制工具、验证证据和显式任务状态提供可靠的完成、暂停、修订、取消与恢复语义。

## Requirements

### Requirement: 通过解耦的异步 AgentLoop 运行任务
系统 SHALL 使用与会话存储、交互界面、具体 Provider、具体工具注册及沙箱实现解耦的 AgentLoop 运行每次模型任务。AgentLoop SHALL 只接收不可变运行输入、Task 级 `ActionTask` 能力和取消信号，并 SHALL 返回 `AsyncIterable<AgentEvent>`；它 MUST NOT 直接接收 `LlmClient`、`ToolExecutor`、原始会话历史或任意 Runner 句柄，MUST NOT 直接调用模型、工具、网络、凭据或沙箱，也 MUST NOT 感知斜杠命令、终端布局或具体模型协议。

每次运行 SHALL 分配唯一 `runId`。同一任务因规划、完善、请求输入、修订、停止后继续或取消后恢复而创建的新运行 SHALL 使用新的 `runId`，并 SHALL 保持同一个 `taskId`；一个用户 turn 可以关联多个运行。HITL 权限等待与决定 SHALL 暂停并恢复同一个 ActiveRun，不得为权限决定创建新 `runId` 或额外模型调用。

#### Scenario: 启动独立运行
- **WHEN** 上层提交有效任务快照、已打开的 `ActionTask` 和取消信号
- **THEN** AgentLoop 创建唯一 `runId`，只通过 ActionTask 请求模型交换或动作批次，并只通过异步 `AgentEvent` 流报告运行状态

#### Scenario: 请求输入后继续原任务
- **WHEN** 一个任务等待用户回答且上层携带匹配的 `taskId` 与 `questionId` 恢复执行
- **THEN** 系统创建新 `runId`、保留原 `taskId`，递增授权 epoch，并由 Secure Context Ledger 为新运行提供筛选后的任务上下文

### Requirement: 默认以 ReAct 模式自主完成任务
普通用户输入 SHALL 显式以 `react` 模式创建新的任务。ReAct 运行 SHALL 在每次迭代中通过 ActionTask 取得一个完整模型响应、提交该响应对应的不透明动作批次引用、观察有序结果并允许模型调整下一步，直到模型通过控制工具停止或运行触发硬停止条件。AgentLoop MUST NOT 接触或重新构造模型返回的原始业务工具参数。

一次迭代 SHALL 定义为“一次完整模型响应及其触发的完整动作批次”。ReAct 单次运行最多 SHALL 执行 10 次迭代。权限拒绝、路径拒绝、正常票据过期、策略拒绝和普通业务工具失败 SHALL 作为 `isError: true` 的结构化观察反馈模型，计入迭代与调用预算，并不得单独终止运行；安全完整性故障除外。

#### Scenario: 工具失败后调整方案
- **WHEN** ReAct 迭代中的业务工具返回结构化失败且运行仍在限制内
- **THEN** AgentLoop 把已获 model destination 授权的安全失败结果作为观察交回模型，并允许下一迭代调整参数、工具或方案

#### Scenario: 权限拒绝后调整方案
- **WHEN** 动作批次中的一个动作返回 `PERMISSION_DENIED` 或 `PREVIOUSLY_DENIED`
- **THEN** AgentLoop 不停止 Task，把不含受保护数据的拒绝结果反馈模型，并允许模型选择低权限替代方案或完成任务

#### Scenario: 达到 ReAct 上限
- **WHEN** ReAct 运行完成第 10 次迭代但仍未进入合法控制终态
- **THEN** AgentLoop 不再调用模型，以 `iteration_limit` 结束当前运行并确定性报告已完成工作、未完成项和最后异常

### Requirement: 只通过私有控制工具改变运行控制状态
AgentLoop SHALL 根据当前阶段动态提供私有控制工具，至少包括 `submit_plan`、`complete_step`、`skip_step`、`complete_task`、`request_user_input` 和 `request_plan_revision`。控制工具 SHALL 使用与业务工具相同的中立定义和 Provider 编码通道，但 MUST NOT 注册到公共业务工具集合、受业务工具开关影响、执行工作区副作用或把原始调用写入普通会话历史。

同一模型响应 MUST 只包含业务工具调用或单个控制工具调用，不得混用两类调用或同时调用多个控制工具。控制工具输入校验失败 SHALL 作为结构化观察反馈模型并计入当前迭代；系统 MUST NOT 因校验失败直接伪造对应状态迁移。

#### Scenario: 禁止混合业务与控制调用
- **WHEN** 同一模型响应同时请求业务工具和 `complete_task`
- **THEN** AgentLoop 不接受完成声明或执行歧义调用，并把稳定协议错误反馈模型

#### Scenario: 业务工具关闭
- **WHEN** 配置关闭全部工作区业务工具
- **THEN** AgentLoop 仍向模型提供当前阶段允许的控制工具，并保持相同完成与停止协议

### Requirement: 使用结构化完成和用户输入协议
ReAct 模式只有在模型单独调用合法 `complete_task`，且非空提交 `result` 与 `verificationSummary` 后 SHALL 以完成状态停止。模型只返回普通文本且没有调用业务或控制工具时 SHALL 被视为无效迭代，系统 SHALL 注入协议纠正观察后继续，并 SHALL 把该轮计入迭代上限；系统 MUST NOT 降级为“普通文本即完成”。

模型缺少继续任务所需的关键信息时 SHALL 单独调用 `request_user_input`。AgentLoop SHALL 发出带唯一 `questionId` 的结构化提问，以 `awaiting_input` 结束当前运行；用户回答后上层 SHALL 创建新运行继续原任务，而不是挂起原异步流。

#### Scenario: 合法完成 ReAct 任务
- **WHEN** 模型在必要工作和验证后单独调用 `complete_task` 并提供非空结果与验证摘要
- **THEN** AgentLoop 接受完成声明、停止调用模型和工具并输出唯一完成终态

#### Scenario: 普通文本未声明完成
- **WHEN** 模型只返回普通文本且没有调用任何工具
- **THEN** AgentLoop 隐藏该中间文本、反馈控制协议要求并继续下一迭代

#### Scenario: 请求用户补充信息
- **WHEN** 模型合法调用 `request_user_input`
- **THEN** AgentLoop 发布关联 `runId`、`taskId` 与 `questionId` 的提问事件并以 `awaiting_input` 停止当前运行

### Requirement: 生成并版本化结构化 Plan
Plan 规划或完善运行 SHALL 只提供 `read_file`、`glob`、`grep` 三个只读业务工具及规划阶段控制工具，MUST NOT 提供 `create_file`、`edit_file` 或 `bash`。模型 SHALL 通过 `submit_plan` 提交结构化 Plan；每次规划运行最多 SHALL 执行 10 次迭代，达到上限仍未成功提交时 MUST NOT 产生可批准计划。

Plan SHALL 包含稳定 `planId`、从 1 开始递增的 `version`、可选 `supersedesVersion`、`goal`、任务级 `successCriteria` 和有序 `steps`。每个步骤 SHALL 包含唯一 `id`、`description`、只指向数组中更早步骤的 `dependencies`、非空 `successCriteria`、`status` 与 `evidence`；状态 SHALL 支持 `pending | in_progress | completed | failed | skipped | invalidated`。提交 SHALL 拒绝重复或未知步骤标识、自依赖、后向依赖和循环依赖。

同一任务的完善或自由输入修订 SHALL 保持 `planId`、递增 `version` 并记录 `supersedesVersion`，旧版本 SHALL 保留为当前进程内历史。修订 SHALL 保留仍有效的已完成步骤及证据；失效的旧结果 SHALL 标记 `invalidated` 并保留证据与失效原因，不得静默覆盖为待执行。

#### Scenario: 只读调查后提交首版计划
- **WHEN** Plan 规划运行使用允许的只读工具取得上下文并提交合法计划
- **THEN** 系统保存 `version: 1` 的计划快照并进入等待批准状态，且规划期间未执行任何写入业务工具

#### Scenario: 拒绝非法依赖
- **WHEN** 提交的步骤依赖自身、未知步骤或数组中更后的步骤
- **THEN** 系统拒绝该计划并把稳定校验错误反馈模型继续修正

#### Scenario: 修订使旧步骤失效
- **WHEN** 新版计划改变目标或范围并使一个已完成步骤的结果不再有效
- **THEN** 新版计划保留该步骤原证据、标记 `invalidated`、记录原因并只让仍需执行的步骤进入待执行状态

### Requirement: 审批并串行执行 Plan
合法 Plan 提交后任务 SHALL 等待用户决定。批准操作 MUST 绑定当前 `planId + version`；过期批准 SHALL 被拒绝并重新提供最新版。用户可以执行计划、继续只读完善、自由输入补充或修改要求、退出任务；自由输入可以改变原目标并生成新版本。

批准后的单个 AgentLoop SHALL 持有完整 Plan，并 SHALL 按数组顺序串行执行步骤；依赖在本版只用于校验和展示，不得触发并行执行。每个步骤内部 SHALL 复用 ReAct 行动、观察与调整循环，每步最多 10 次迭代，整个计划单次执行运行最多 50 次迭代。被跳过步骤的依赖者 MUST NOT 执行，除非后续计划修订移除或替换该依赖。

#### Scenario: 批准当前计划
- **WHEN** 用户针对当前 `planId + version` 选择执行计划
- **THEN** 系统提供配置允许的完整业务工具集，从首个可执行未完成步骤开始串行运行

#### Scenario: 拒绝过期批准
- **WHEN** 用户批准的版本已被自由输入修订或继续完善产生的新版本取代
- **THEN** 系统不执行旧版并重新展示当前最新版计划

#### Scenario: 串行执行依赖步骤
- **WHEN** 一个计划包含互不依赖或具有前序依赖的多个步骤
- **THEN** AgentLoop 仍严格按数组顺序一次执行一个步骤，不并行调度步骤

### Requirement: 根据成功标准和证据更新 Plan
模型 SHALL 通过单独的 `complete_step` 提交当前 `stepId`、对每条步骤成功标准的验证结果及简短 `evidence`。只有全部标准验证通过后系统 SHALL 把步骤标记为 `completed`；失败的声明 SHALL 作为观察反馈模型继续调整。

模型可以通过 `skip_step` 提交步骤标识和明确理由；跳过 SHALL 保留理由且阻断依赖该步骤的后续步骤。Plan 模式的 `complete_task` 只有在全部有效步骤均为 `completed`，或带明确理由为 `skipped`，完成步骤均有证据，并且模型逐项提交任务级成功标准的验证结果与证据时 SHALL 被接受。

#### Scenario: 步骤验证通过
- **WHEN** `complete_step` 对当前步骤的每条成功标准提交通过结果和非空简短证据
- **THEN** 系统把步骤标记为 `completed` 并发布对应步骤完成事件

#### Scenario: 任务级集成验证缺失
- **WHEN** 全部步骤已结束但 `complete_task` 未逐项提供任务级成功标准的验证证据
- **THEN** 系统拒绝任务完成声明并把校验错误反馈模型

### Requirement: 在实质变更时暂停并重新审批
Plan 执行中允许模型在不改变目标、范围或副作用边界时自主调整步骤内做法。需要实质改变目标、范围或副作用时，模型 SHALL 单独调用 `request_plan_revision`，提交原因与建议变更；AgentLoop SHALL 以 `plan_revision` 停止当前运行，任务 MUST 在生成并批准新版本前停止执行剩余步骤。

执行中仅缺少事实信息时 SHALL 使用 `request_user_input`，而不是计划修订。用户回答匹配问题后系统 SHALL 继续当前已批准版本和当前步骤，不递增版本也不再次审批。

#### Scenario: 请求实质修订
- **WHEN** 当前计划无法继续且建议方案会扩大范围或新增副作用
- **THEN** AgentLoop 发布计划修订请求并停止，后续业务工具必须等待新版计划批准

#### Scenario: 回答执行问题
- **WHEN** 已批准 Plan 在当前步骤请求一项事实信息且用户提交匹配回答
- **THEN** 系统以新运行继续同一计划版本和步骤，不要求再次批准

### Requirement: 以四类停止条件约束运行
AgentLoop SHALL 只因以下条件停止当前运行：合法控制工具主动完成或请求暂停、达到迭代上限、用户取消、异常状态。异常状态 SHALL 包括不可恢复的模型、协议、工具调度或内部错误，以及连续三次无进展。

无进展 SHALL 以一次迭代的完整有序调用批次为粒度；系统 SHALL 对工具名、规范化参数和忽略耗时、时间戳等易变字段后的稳定结果摘要生成批次指纹。连续三次业务工具批次指纹相同，或连续三次相同控制工具输入产生同一稳定校验错误时，系统 SHALL 以 `abnormal` 停止。

所有运行 SHALL 以唯一 `run_stopped` 事件结束，`reason` SHALL 为 `completed | iteration_limit | cancelled | abnormal | awaiting_input | plan_revision` 之一。达到上限 SHALL 是硬边界，不得额外调用模型总结。取消 SHALL 使用同一 `AbortSignal` 终止模型流和当前工具批次，等待取消收尾后再发布终态；终态之后 MUST NOT 发布迟到事件。

#### Scenario: 连续重复业务批次
- **WHEN** 连续三次迭代执行相同有序业务工具批次并得到等价结果
- **THEN** AgentLoop 以 `abnormal` 停止且不执行第四次相同批次

#### Scenario: 用户取消工具批次
- **WHEN** 用户在模型流或工具批次运行期间取消任务
- **THEN** 系统取消底层工作、完成收尾后只发布一次 `run_stopped` 且原因为 `cancelled`

### Requirement: 发布不含内部推理的结构化 AgentEvent
每个 `AgentEvent` SHALL 携带 `runId`；迭代事件 SHALL 携带迭代序号，Plan 事件 SHALL 按需携带 `planId`、`version` 与 `stepId`。事件流至少 SHALL 表达 `iteration_started`、`iteration_completed`、`plan_step_started`、`plan_step_completed`、`plan_step_failed`、`plan_step_skipped`、工具状态、用户提问、计划修订和统一 `run_stopped`。

AgentEvent SHALL 只包含结构化领域数据、状态、工具摘要与结果摘要，不得包含终端布局文案或模型内部推理。模型在业务工具前产生的普通文本 SHALL 只保留在本次运行的私有协议历史中，不得转发给用户或写入普通会话历史；行动说明 SHALL 根据工具调用、迭代和步骤状态确定性生成。私有运行历史 SHALL 在运行结束后释放，只向上层返回结构化结果和必要摘要。

#### Scenario: 观察 Plan 步骤运行
- **WHEN** Plan 执行一个包含多次工具迭代的步骤
- **THEN** 消费方通过带关联标识的步骤、迭代和工具事件确定当前进度，无需解析模型文本

#### Scenario: 模型输出工具前思考文本
- **WHEN** 模型在同一响应中先输出普通文本再请求业务工具
- **THEN** 系统为协议连续性保留该文本但不产生用户可见文本事件或普通历史消息

### Requirement: 使用最小且可组合的模式提示词
系统 SHALL 通过独立可测试的 Prompt 组装契约，把生产级静态 System Prompt 与当前运行的 SystemReminder 分离。静态任务模式模块 SHALL 定义 ReAct 与 Plan 的通用语义、切换规则、控制工具协议和完成条件，并 SHALL 在每次请求保持相同内容；当前模式、阶段、迭代上限、可选当前 Plan、当前步骤、成功标准、已有证据和协议纠错 SHALL 作为紧凑但完整的 `runtime_state` 动态片段随每次请求提供。

普通任务 SHALL 默认使用 ReAct，只有用户显式选择 `/plan` 才 SHALL 进入 Plan；模型可以建议 Plan，但 MUST NOT 自行切换模式。系统 MUST NOT 使用“首轮完整、间隔轮次重复、其余精简”的注入策略，也 MUST NOT 把运行状态伪装成用户或 assistant 历史消息。

提示词 SHALL 指导模型先调查可自行查明的事实；低风险、可逆且不改变任务目标的合理假设可以继续执行并在结果中披露，只有缺失信息会显著改变目标、范围、外部副作用或不可逆风险时才调用 `request_user_input`。诊断、解释、评审和规划请求 SHALL 默认只读；用户明确要求修改、构建或修复时，模型可以在当前可用工具范围内实施并验证。提交、推送、创建 PR、部署、删除数据及其他外部或高影响操作 SHALL 要求用户明确授权，但该要求仅是模型软约束，MUST NOT 被描述为已实现的运行时权限系统。

模型只有在完成与风险相称的真实验证后才 SHALL 调用 `complete_task`，并 SHALL 在验证摘要中区分已通过、失败、未运行和受外部条件阻塞。代码已写入、类型检查通过或局部测试通过 MUST NOT 被自动等同为整个任务完成，且模型 MUST NOT 虚构工具结果或验证证据。

#### Scenario: 构建 ReAct 运行上下文
- **WHEN** AgentLoop 启动默认 ReAct 任务
- **THEN** 模型收到完整稳定提示词与声明 ReAct、当前阶段和迭代预算的动态片段，且不包含当前未激活的 Plan 步骤状态

#### Scenario: 构建 Plan 步骤上下文
- **WHEN** AgentLoop 执行已批准计划中的当前步骤
- **THEN** 模型收到相同稳定提示词，以及包含当前计划、步骤、成功标准和已有证据的动态运行状态

#### Scenario: 可自行查明信息
- **WHEN** 继续任务所需事实能够通过当前只读工具获得
- **THEN** 提示词要求模型先调查而不是立即请求用户输入

#### Scenario: 关键歧义改变副作用
- **WHEN** 缺失信息会决定是否执行不可逆或外部副作用
- **THEN** 提示词要求模型停止相关动作并调用 `request_user_input`

#### Scenario: 完成前验证不足
- **WHEN** 模型只完成代码修改但没有取得任务成功标准所需的验证证据
- **THEN** 提示词禁止把整个任务声明为已验证完成，并要求继续验证或明确报告未验证状态

### Requirement: 在进程内管理唯一活动任务及恢复
每个顶层普通输入 SHALL 创建一个新的 ReAct 任务，`/plan` SHALL 创建一个 Plan 任务；一个会话任一时刻最多 SHALL 存在一个未结束任务。任务状态 SHALL 使用 `running | awaiting_input | awaiting_approval | stopped | cancelled | completed | exited`，并 SHALL 只允许定义的状态迁移。Plan 子状态 SHALL 使用 `draft | awaiting_approval | executing | awaiting_input | awaiting_revision | cancelled | completed`，并 SHALL 校验两层状态组合。

达到 `iteration_limit` 或 `abnormal` 后任务 SHALL 进入可恢复的 `stopped`；用户可以选择继续、补充要求或退出。每次明确继续 SHALL 创建新 `runId` 并重置单次运行上限，系统 SHALL 记录累计运行次数与总迭代数供展示，但 MUST NOT 设置隐藏的累计硬上限。用户取消 SHALL 进入可恢复的 `cancelled`；恢复 ReAct 可以继续，恢复 Plan MUST 先重新展示当前计划与进度并再次确认。

活动任务、Plan 版本和完整运行状态 SHALL 只存在于当前进程。退出任务 SHALL 释放活动状态，但 SHALL 在普通会话历史保留退出原因、已完成工作、未完成项和已产生副作用的简短摘要；退出或取消 MUST NOT 回滚副作用。

#### Scenario: 阻止并存任务
- **WHEN** 当前存在未结束任务且用户尝试创建新的 `/plan`
- **THEN** 系统拒绝创建新任务并要求先完成、取消或退出当前任务

#### Scenario: 用户继续异常停止的任务
- **WHEN** 用户对 `stopped` 任务明确选择继续
- **THEN** 系统保留既有进度和副作用、创建新运行并重新应用单次运行迭代上限

#### Scenario: 重启 Weave
- **WHEN** 用户退出并重新启动进程
- **THEN** 系统不恢复活动任务、Plan 版本或运行状态，仅按既有会话存储边界开始新会话

### Requirement: 权限等待必须暂停同一个 ActiveRun

当完整动作批次预检产生一个或多个 `ask` 时，AgentLoop SHALL 发布结构化 `authorization_requested` 事件并暂停当前 ActiveRun、当前迭代和对应 `ProposalBatchRef`。暂停期间系统 MUST 只接受绑定该请求的 `resolve_authorization` 或 Task 取消，普通输入、计划决定、其他控制工具和新的模型交换 MUST 返回 busy。决定完成后 SHALL 在同一 `runId` 内继续尚未执行的批次，且预检前 MUST 没有任何批次动作开始执行。

#### Scenario: 同一批次需要人工授权
- **WHEN** 五层决策链把一个模型动作批次中的两项标记为 `ask`
- **THEN** 系统一次展示两项但逐项收集决定，在同一运行中解析完整决定集后才执行获准动作或返回拒绝结果

### Requirement: 计划审批不得授予动作权限

Plan 的 `planId + version` 审批 MUST 只允许进入计划执行状态，MUST NOT 创建工具、路径、网络、凭据、披露或持久化授权。计划执行中的每个动作仍 MUST 按当前权限模式、规则、epoch 和五层决策链单独预检。

#### Scenario: 已批准计划包含高风险 shell
- **WHEN** 用户批准 Plan 后模型提出需要 HITL 的 shell 动作
- **THEN** 计划批准不满足该动作授权，系统仍暂停同一运行并展示独立权限请求

### Requirement: 安全完整性故障必须终止 Task

票据签名或绑定不匹配、票据重放、Runner 身份失败、沙箱认证丢失、执行前审计失败及其他安全不变量破坏 MUST 作为 `security_integrity_failure` 终止整个 Task、撤销未使用票据并阻止继续模型调用。系统 MUST NOT 把该类故障包装成模型可尝试绕过的普通工具错误。

#### Scenario: Runner 报告票据摘要不匹配
- **WHEN** Runner 重新规范化后的动作摘要与票据绑定摘要不同
- **THEN** AgentLoop 收到 Task 终止事件而不是普通观察，且模型没有机会提交修改后的同一动作
