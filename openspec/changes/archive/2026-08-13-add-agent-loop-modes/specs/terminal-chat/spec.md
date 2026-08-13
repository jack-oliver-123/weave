## MODIFIED Requirements

### Requirement: 启动全屏终端对话界面
系统 SHALL 在配置、工作区和 Node.js 版本校验通过后进入全屏 TUI。首版运行时 SHALL 要求 Node.js 22 或更高版本，并 SHALL 提供 `--config`、`--profile`、`--workspace`、`--tools`、`--no-tools`、`--help` 和 `--version` 命令行选项。`--tools` 与 `--no-tools` MUST 互斥；`--workspace` 指定目录不存在或不是目录时 SHALL 在进入 TUI 前失败。工作区 MUST NOT 写入配置文件。

业务工具启用时系统 SHALL 初始化六个核心业务工具和工具执行器；业务工具禁用时 SHALL 不初始化工作区业务工具，但两种配置都 SHALL 初始化 AgentLoop 控制工具并使用统一 ReAct/Plan 任务路径，不得退回纯文本直通路径。

#### Scenario: 正常进入业务工具模式 TUI
- **WHEN** Node.js、配置和工作区均有效且业务工具最终解析为启用
- **THEN** 系统初始化六个业务工具、工具执行器和 AgentLoop，进入全屏终端界面并等待用户输入

#### Scenario: 正常进入无业务工具 TUI
- **WHEN** 用户通过配置或 `--no-tools` 禁用业务工具
- **THEN** 系统不初始化工作区业务工具，但仍初始化 AgentLoop 控制协议并使用统一任务路径

#### Scenario: Node.js 版本过低
- **WHEN** 运行时版本低于 Node.js 22
- **THEN** 系统在进入全屏模式前输出中文版本错误并以非零状态退出

#### Scenario: 配置启动失败
- **WHEN** 配置文件不存在、无法解析或 profile 无效
- **THEN** 系统不进入全屏模式，不启动配置向导，并在普通终端输出脱敏的中文诊断

#### Scenario: 工作区启动失败
- **WHEN** `--workspace` 缺少参数、目标不存在或目标不是目录
- **THEN** 系统在进入全屏模式前输出中文工作区诊断并以非零状态退出

#### Scenario: 工具开关冲突
- **WHEN** 用户同时提供 `--tools` 和 `--no-tools`
- **THEN** 系统拒绝启动并说明两个参数互斥

#### Scenario: 只暴露已实现命令
- **WHEN** 用户查看帮助或在 TUI 输入内容
- **THEN** 系统声明支持 `/plan <任务>`，且不宣称支持 `/model`、`/clear`、`/mcp` 或其他未实现命令

## ADDED Requirements

### Requirement: 显式选择 ReAct 或 Plan 模式
交互层 SHALL 把每个顶层输入解析为显式任务模式。普通非空输入 SHALL 以 `react` 模式提交；`/plan <任务>` SHALL 移除命令前缀并以 `plan` 模式提交纯任务文本。空 `/plan` SHALL 显示用法且不得创建任务。当前存在未结束任务时，系统 SHALL 拒绝创建新的 `/plan`，不得隐式取消或排队模式切换命令。

#### Scenario: 提交默认 ReAct 任务
- **WHEN** 空闲时用户提交不以 `/plan` 开头的非空文本
- **THEN** 交互层提交显式 `mode: "react"` 和原任务文本

#### Scenario: 提交 Plan 任务
- **WHEN** 空闲时用户输入 `/plan 修复登录问题`
- **THEN** 交互层提交显式 `mode: "plan"` 和纯任务文本 `修复登录问题`

#### Scenario: 活动任务期间切换模式
- **WHEN** 当前任务未结束且用户输入新的 `/plan`
- **THEN** TUI 拒绝创建或排队新 Plan，并提示先完成、取消或退出当前任务

### Requirement: 在单页中展示并决策结构化计划
Plan 提交成功后，TUI SHALL 在唯一转录滚动区域末尾以紧凑格式展示目标、任务级成功标准、步骤、依赖和步骤成功标准；取消恢复或修订时 SHALL 额外展示状态与证据摘要。TUI SHALL 提供 `执行计划`、`继续完善`、`退出任务` 三个固定选项，并 SHALL 保持输入框可用，任意自由输入均作为补充或修改要求生成新 Plan 版本。

计划选项 MUST NOT 使用弹窗、独立全屏页或第二滚动区域。批准 SHALL 绑定当前 `planId + version`；版本过期时 TUI SHALL 展示最新版而不得执行旧版。

#### Scenario: 展示待批准计划
- **WHEN** Plan 规划运行提交合法结构化计划
- **THEN** 用户在现有转录区看到完整紧凑计划、三个固定选项和可用输入框

#### Scenario: 自由输入补充要求
- **WHEN** Plan 等待决定时用户输入非空补充内容并提交
- **THEN** TUI 将内容路由为当前计划修订要求，并在新版本生成后重新展示决策界面

#### Scenario: 继续完善计划
- **WHEN** 用户选择 `继续完善`
- **THEN** 系统启动只读规划运行，新版 `submit_plan` 成功后回到同一等待决策界面

### Requirement: 在等待计划决策时复用输入按键
仅当 Plan 等待用户决定且输入框为空时，`↑` 与 `↓` SHALL 在三个固定选项之间移动选择，`Enter` SHALL 确认当前选项。一旦输入框包含文本，方向键 SHALL 恢复编辑语义，`Enter` SHALL 提交自由输入作为计划修订要求。普通聊天状态 MUST NOT 占用 `↑`，以保留未来输入历史能力。

#### Scenario: 空输入选择计划操作
- **WHEN** Plan 等待决定且输入框为空
- **THEN** 用户使用 `↑/↓` 切换选项并用 `Enter` 确认，输入框不获得伪造文本

#### Scenario: 输入补充内容
- **WHEN** Plan 等待决定且输入框已有文本
- **THEN** 方向键用于编辑，`Enter` 提交补充要求而不是触发当前高亮选项

### Requirement: 展示任务停止与恢复操作
任务因迭代上限或异常进入可恢复停止时，TUI SHALL 展示 `继续`、`补充要求`、`退出任务`；用户主动取消后 SHALL 展示可用的恢复与退出操作。继续 SHALL 显示新的运行标识并保留累计运行次数、总迭代数、已完成工作和未完成项。恢复 Plan 时 MUST 先重新展示当前计划版本与进度，并等待用户确认执行。

#### Scenario: 继续达到上限的 ReAct 任务
- **WHEN** ReAct 任务以 `iteration_limit` 停止且用户选择继续
- **THEN** TUI 保留既有摘要并显示新运行状态，不把继续伪装为原流恢复

#### Scenario: 恢复取消的 Plan
- **WHEN** 用户选择恢复已取消 Plan
- **THEN** TUI 先展示当前计划与证据进度，只有用户再次选择执行才启动新运行

### Requirement: 持续显示当前任务模式

TUI SHALL 在现有底部状态栏持续显示当前任务模式，不得从用户或模型的转录文本推断。无活动任务时 SHALL 显示 `ReAct · 就绪`；ReAct 运行中 SHALL 保留 `ReAct` 标识；Plan SHALL 根据结构化提交、`TaskAction`、`plan_ready`、`plan_step` 与 `task_state` 显示 `规划中 | 待确认 | 执行 n/m | 等待输入 | 已停止 | 已取消`。Plan 完成或退出后 SHALL 回落到 `ReAct · 就绪`。

滚动提示、队列状态、反馈文案、等待响应和运行耗时 SHALL 追加在模式与阶段之后，MUST NOT 覆盖当前模式。本变更 MUST NOT 增加状态栏高度、弹窗、独立页面或第二滚动区域。

#### Scenario: 进入 Plan 规划与待确认
- **WHEN** 用户提交 `/plan <任务>` 且计划随后生成
- **THEN** 底部状态栏先显示 `Plan · 规划中`，收到 `plan_ready` 后显示 `Plan · 待确认`

#### Scenario: 显示 Plan 执行进度
- **WHEN** 用户批准包含 m 个步骤的 Plan 且第 n 个步骤开始
- **THEN** 底部状态栏显示 `Plan · 执行 n/m`

#### Scenario: 暂停状态仍保留 Plan 标识
- **WHEN** Plan 等待输入、达到迭代停止或被用户取消
- **THEN** 底部状态栏分别显示 `Plan · 等待输入`、`Plan · 已停止` 或 `Plan · 已取消`

#### Scenario: 临时状态不覆盖模式
- **WHEN** 用户滚动查看上文、队列暂停或界面显示短暂反馈
- **THEN** 状态栏仍以 `ReAct` 或 `Plan` 及当前阶段开头，临时状态仅作为后缀

#### Scenario: Plan 结束后回落默认模式
- **WHEN** Plan 执行完成或用户退出任务
- **THEN** 底部状态栏恢复为 `ReAct · 就绪`
