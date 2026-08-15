# terminal-chat Specification

## Purpose

定义 Weave 面向用户的全屏终端对话体验，包括 Claude Code 风格的单页布局、小狗品牌标识、流式文本、输入按键、滚动与尺寸响应、安全渲染以及 Windows 和 WSL 验收边界。

## Requirements

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

### Requirement: 呈现稳定的单页对话布局
TUI SHALL 使用静态小狗 ASCII 品牌标识，并 SHALL 显示 Weave 版本、工作目录、当前 `protocol / model`、单一对话区域、固定输入框和状态栏。费用、上下文比例、权限、Agents 与 MCP 等未实现状态 SHALL 留空，不得显示伪造数据或可交互入口。

#### Scenario: 首屏布局
- **WHEN** TUI 完成启动
- **THEN** 用户看到小狗标识、版本、工作目录、协议和模型、空对话区、输入框与状态栏

#### Scenario: 区分 OpenAI 协议
- **WHEN** 分别使用 OpenAI Chat Completions 和 OpenAI Responses profile 启动
- **THEN** 状态栏显示不同协议名称，即使两者使用相同模型名

#### Scenario: 未实现状态留空
- **WHEN** 首版尚未接入费用、上下文比例、权限、Agents 或 MCP
- **THEN** 对应布局位置不展示虚假值、说明文字或可操作控件

### Requirement: 渐进式显示 Markdown 回答
TUI SHALL 按 turn 顺序保留 assistant 原始安全文本，并 SHALL 将已形成完整语法边界的 Markdown 内容渐进渲染为终端样式。系统 SHALL 支持标题、段落、粗体、斜体、删除线、无序列表、有序列表、任务列表、引用、行内代码、围栏代码块、链接、分隔线和表格；尚未闭合的尾段 SHALL 暂按纯文本显示，并 SHALL 在语法闭合或 turn 结束后就地规范化。小狗标识 SHALL 保持静态，生成状态 SHALL 单独显示等待、生成、完成、截断、拒答、中断或错误及响应耗时。

#### Scenario: 等待首个文本片段
- **WHEN** turn 已开始但尚未收到文本
- **THEN** 回答区域显示旋转等待状态且小狗标识不重绘动画

#### Scenario: 渐进渲染完整块
- **WHEN** 流式增量形成完整的标题、段落、列表、引用或分隔线
- **THEN** TUI 立即显示对应终端样式且不暴露仅用于标记样式的 Markdown 符号

#### Scenario: 保持未闭合尾段稳定
- **WHEN** 最新增量以未闭合的强调、链接、代码围栏或其他不完整 Markdown 语法结束
- **THEN** TUI 暂以纯文本显示该尾段且不得导致已完成内容闪烁或反复跳动

#### Scenario: 完成时规范化回答
- **WHEN** TUI 收到正常、截断或有文本拒答的完成事件
- **THEN** 系统对完整回答执行最终 Markdown 渲染并保留对应完成状态与耗时

#### Scenario: 取消时保留部分回答
- **WHEN** 用户取消已有部分文本的 turn
- **THEN** 系统保留可安全解析的已生成内容、以纯文本保留未闭合尾段并显示“已中断”标记

#### Scenario: 响应式显示表格
- **WHEN** Markdown 包含表格
- **THEN** 宽度足够时 TUI 显示对齐表格，宽度不足时按记录转换为“列名：内容”的逐行布局且不创建横向滚动区

#### Scenario: 显示围栏代码块
- **WHEN** Markdown 包含带语言或不带语言的围栏代码块
- **THEN** TUI 保留原始缩进和逻辑换行，显示可用的语言标签，并对超宽代码行进行带弱化续行标记的视觉折行

#### Scenario: 安全语法高亮
- **WHEN** 代码块声明了可识别语言且终端支持颜色
- **THEN** TUI 使用自身生成的终端样式进行语法高亮；语言未知或颜色不可用时退化为等宽纯文本

### Requirement: 按实际显示行布局终端内容
TUI SHALL 依据当前可用列宽和 Unicode 终端显示宽度计算对话、Markdown 块和输入内容占用的实际屏幕行，SHALL 正确处理中文、Emoji、组合字符、缩进和自动折行，并 SHALL 使用同一显示行模型计算视口、滚动偏移、输入框高度和真实光标位置。

#### Scenario: 长文本自动折行
- **WHEN** 用户输入或回答中的逻辑行超过可用列宽
- **THEN** TUI 按实际折行数分配和滚动屏幕行且不截掉后续内容

#### Scenario: 宽字符与组合字符
- **WHEN** 文本同时包含 ASCII、中文、Emoji 或组合字符
- **THEN** TUI 的折行边界、缩进、滚动位置和光标列保持一致

#### Scenario: 输入内容超过可见高度
- **WHEN** 输入内容的实际显示行超过输入框可分配高度
- **THEN** TUI 保持光标所在内容可见并不得创建可与对话区独立滚动的第二滚动条

#### Scenario: 调整终端宽度
- **WHEN** 终端宽度变化且仍满足最小尺寸
- **THEN** TUI 重新计算所有实际显示行并保持当前阅读锚点、输入草稿和光标语义位置

### Requirement: 使用真实终端光标
TUI SHALL 不使用文本字符模拟输入光标，SHALL 保留用户终端的原生光标形状、颜色和闪烁设置，并 SHALL 在每次渲染、编辑、自动折行或窗口变化后将真实终端光标定位到输入框的实际插入点。

#### Scenario: CMD 中文输入
- **WHEN** 用户在 Windows 11 CMD 中使用中文输入法编辑单行或多行文本
- **THEN** 输入法候选窗跟随输入框中的实际插入位置而不是出现在页面右下角

#### Scenario: 跨 Windows 终端输入多行
- **WHEN** 用户需要在输入框中插入换行
- **THEN** Windows Terminal 1.25+ 在增强键盘协议可用时支持 `Shift+Enter`，经典 Console Host 支持 `Ctrl+J`，且两个环境中的普通 `Enter` 均保持提交语义

#### Scenario: 移动 Unicode 文本光标
- **WHEN** 用户在包含中文、Emoji 或组合字符的输入中移动光标
- **THEN** 原生光标显示在对应字素边界且不会拆分可见字符

#### Scenario: 离开全屏界面
- **WHEN** TUI 正常退出或因异常执行清理
- **THEN** 系统恢复进入全屏模式前的光标可见性和终端状态

### Requirement: 管理生成期间的消息队列
TUI SHALL 在 assistant 生成期间将用户按 `Enter` 提交的非空草稿加入先进先出队列并立即清空输入框，SHALL 继续保持单活动 turn，且 SHALL 在当前 turn 正常完成后按入队顺序使用一个空行连接所有队列项并自动提交为一条用户消息。队列 SHALL 仅存在于当前进程，不得被宣称为持久化数据。

#### Scenario: 生成期间连续入队
- **WHEN** assistant 正在生成且用户先后提交多条非空草稿
- **THEN** TUI 按提交顺序保存队列项、清空每次已入队输入且不创建并发 turn

#### Scenario: 显示队列摘要
- **WHEN** 队列非空
- **THEN** TUI 在固定区域显示队列数量与最新一条的截断预览且不创建第二滚动区域

#### Scenario: 正常完成后合并发送
- **WHEN** 当前 turn 正常完成且队列非空
- **THEN** TUI 使用一个空行连接所有队列项并自动提交一条新的用户消息

#### Scenario: 保留未入队草稿
- **WHEN** 当前 turn 完成时输入框还包含未按 `Enter` 提交的草稿
- **THEN** 自动发送只消费已入队内容且未入队草稿保持原样

#### Scenario: 非正常终态暂停队列
- **WHEN** 当前 turn 以错误、中断、截断或拒答结束且队列非空
- **THEN** TUI 保留队列、暂停自动发送并显示可恢复提示

#### Scenario: 显式恢复暂停队列
- **WHEN** 队列已暂停且用户按 `Enter`
- **THEN** 输入框为空时系统发送现有合并队列，输入框非空时先将草稿追加到队尾再合并发送

#### Scenario: 撤回最后一条队列消息
- **WHEN** 队列非空且用户按 `Ctrl+Z`
- **THEN** TUI 将最后入队的内容移回输入框、不得覆盖已有未入队草稿、保持其余队列顺序并显示撤回反馈

#### Scenario: 队列非空时准备退出
- **WHEN** 队列非空且用户第一次按 `Ctrl+C` 进入二次退出窗口
- **THEN** TUI 不清空队列并提示再次退出将丢失的队列项数量

#### Scenario: 确认退出后丢弃队列
- **WHEN** 用户在二次退出窗口内再次按 `Ctrl+C`
- **THEN** TUI 正常退出、恢复终端状态并丢弃仅存在于当前进程的队列

### Requirement: 支持明确的输入与退出按键
输入框 SHALL 支持多行文本，`Enter` SHALL 在空闲时提交；Windows Terminal 1.25+ 在增强键盘协议可用时 SHALL 使用 `Shift+Enter` 插入换行，经典 Console Host SHALL 使用 `Ctrl+J` 插入换行；多行粘贴 SHALL 保持原始换行。生成期间输入框 SHALL 继续允许编辑，并 SHALL 将 `Enter` 提交的非空草稿加入进程内队列而不创建并发 turn。

#### Scenario: 提交单轮输入
- **WHEN** 输入框包含非空文本且用户按下 `Enter`
- **THEN** 系统提交该文本并开始新的 turn

#### Scenario: 插入换行
- **WHEN** 用户在支持增强键盘协议的 Windows Terminal 1.25+ 按下 `Shift+Enter`，或在经典 Console Host 按下 `Ctrl+J`
- **THEN** 输入框在当前光标位置插入换行且不提交

#### Scenario: 生成期间编辑
- **WHEN** assistant 正在生成且用户输入新草稿
- **THEN** 草稿保持可编辑，按下提交键时加入队列且不得创建并发 turn

#### Scenario: 第一次 Ctrl+C
- **WHEN** 用户第一次按下 `Ctrl+C`
- **THEN** 系统在生成中取消当前 turn，或在空闲时清空当前输入，并进入持续 2 秒的再次按下退出状态

#### Scenario: 第二次 Ctrl+C 退出
- **WHEN** 用户在第一次 `Ctrl+C` 后 2 秒内再次按下 `Ctrl+C`
- **THEN** 系统正常退出并恢复进入全屏模式前的终端状态

#### Scenario: Ctrl+C 窗口超时
- **WHEN** 第一次 `Ctrl+C` 后超过 2 秒未再次按下
- **THEN** 退出计数重置，下一次按下重新作为第一次处理

### Requirement: 对话区是唯一滚动区域
TUI SHALL 只让对话区滚动，输入框、队列摘要和状态栏 SHALL 固定且不得产生第二滚动条。流式输出 SHALL 默认跟随底部；用户通过鼠标滚轮或键盘手动上滚后 SHALL 暂停自动跟随、保持阅读锚点并显示新增实际行数，回到底部后 SHALL 恢复自动跟随。终端任意位置的滚轮事件 SHALL 只作用于对话区。

#### Scenario: 自动跟随流式输出
- **WHEN** 用户位于对话底部且收到新文本
- **THEN** 对话区保持显示最新文本

#### Scenario: 使用滚轮查看历史
- **WHEN** 用户在终端任意位置向上滚动鼠标滚轮
- **THEN** 仅对话区按实际显示行向上滚动且输入框、队列摘要和状态栏保持固定

#### Scenario: 阅读历史时暂停跟随
- **WHEN** 用户手动上滚后收到新文本
- **THEN** 系统保持当前阅读锚点、不强制跳到底部，并显示“正在查看上文”、新增实际行数和 `Ctrl+End` 返回提示

#### Scenario: 返回底部恢复跟随
- **WHEN** 用户向下滚回底部或按 `Ctrl+End`
- **THEN** 滚动提示消失且后续流式文本再次自动跟随

#### Scenario: 输入内容增长
- **WHEN** 输入框包含多行或自动换行文本
- **THEN** 布局按实际显示行调整输入框高度且不创建独立滚动区域

### Requirement: 响应终端尺寸变化
TUI SHALL 支持运行期间调整终端尺寸。终端小于 `80×24` 时 SHALL 暂停正常布局并只显示单一尺寸提示；尺寸恢复后 SHALL 恢复原会话和原输入。

#### Scenario: 终端缩小到最小尺寸以下
- **WHEN** 终端列数小于 80 或行数小于 24
- **THEN** 系统显示“终端窗口过小”提示且不显示第二滚动区域

#### Scenario: 终端尺寸恢复
- **WHEN** 终端恢复到至少 `80×24`
- **THEN** 系统恢复对话布局、历史、活动状态和输入草稿

### Requirement: 安全渲染终端文本
系统 SHALL 在渲染和写入对话历史前移除用户输入与模型输出中的 ANSI 转义序列和危险控制字符，但 SHALL 保留普通 Unicode、换行和制表符。

#### Scenario: 模型输出 ANSI 控制序列
- **WHEN** 文本增量包含清屏、改标题、移动光标或颜色等 ANSI 序列
- **THEN** TUI 不执行该序列，显示和历史中均只保留清理后的安全文本

#### Scenario: 正常中文与代码文本
- **WHEN** 文本包含中文、普通 Unicode、换行、制表符或 Markdown 代码围栏字符
- **THEN** 系统保持这些文本内容与顺序

### Requirement: 提供可重复的跨终端验收
系统 SHALL 提供不访问真实 API 的确定性终端 E2E，并 SHALL 将真实协议 smoke 与默认测试分离。Windows 11 CMD 与 PowerShell/Windows Terminal SHALL 作为正式支持环境接受自动化终端验证，WSL2 Ubuntu SHALL 使用原生 `tmux` 验收；无法由 pane 文本观察的中文输入法候选窗位置 SHALL 通过可重复的 Windows 人工 smoke 验收。工具启用的默认 E2E SHALL 使用可控模型流和临时工作区，不得执行真实外部模型请求。

#### Scenario: Windows 终端 E2E
- **WHEN** 在 Windows 执行确定性 TUI E2E
- **THEN** 自动化验证 CMD 与 PowerShell/Windows Terminal 下的启动布局、Markdown、实际行折行、按键、滚轮事件、队列、工具状态、尺寸变化、单一滚动区域、单一标题和正常退出

#### Scenario: CMD 中文输入法 smoke
- **WHEN** 验收者在 Windows 11 CMD 中按规定步骤使用中文输入法编辑单行、多行、自动折行和 Unicode 混合文本
- **THEN** 候选窗跟随真实插入点、原生光标位置正确、经典 Console Host 的 `Ctrl+J` 与 Windows Terminal 1.25+ 的 `Shift+Enter` 可插入换行，且退出后终端状态恢复

#### Scenario: WSL 终端 E2E
- **WHEN** 在 WSL2 Ubuntu 执行确定性 TUI E2E
- **THEN** `tmux` 执行与 Windows 等价的 Markdown、布局、键盘滚动、队列、工具状态和终端恢复场景；不宣称验证 Windows 输入法窗口

#### Scenario: 默认测试不使用真实 API
- **WHEN** 执行默认测试套件
- **THEN** 测试使用可控的假流客户端和临时工作区，且不读取 `~/.weave/config.yaml`

#### Scenario: 三协议真实 smoke
- **WHEN** 显式执行 live smoke 并提供有效本地配置
- **THEN** 工具 smoke 与纯文本 smoke 分开报告，不因默认自动化闭环通过而宣称真实 Provider 工具能力已验证

### Requirement: 在单一对话区域显示紧凑工具状态
TUI SHALL 为每个工具调用按原调用顺序显示紧凑状态，至少包含 `等待执行`、`执行中`、`成功`、`失败` 和 `跳过`。状态 SHALL 显示工具名与安全摘要，例如相对路径、搜索模式或截断后的 Bash 命令；失败状态 SHALL 显示简短错误码和中文原因。TUI MUST NOT 默认展开完整参数、文件内容、stdout、stderr 或错误详情。

并行读取批次中的状态 SHALL 独立更新且不得根据完成顺序重排行。过程文本 SHALL 与工具状态按时间保留，最终答复 MUST NOT 覆盖此前工具轨迹。首版 MUST NOT 增加折叠详情面板、Diff 页面或执行时间线页面。

#### Scenario: 并行工具执行
- **WHEN** 一个只读批次中的多个调用以不同顺序完成
- **THEN** 每行状态独立更新但显示顺序保持模型原调用顺序

#### Scenario: 工具失败和跳过
- **WHEN** 写入调用失败且后续调用被标记为 `PRIOR_WRITE_FAILED`
- **THEN** TUI 分别显示失败工具的错误摘要及后续工具的跳过状态

#### Scenario: Bash 运行期间
- **WHEN** Bash 子进程仍在执行
- **THEN** TUI 只显示执行中状态，不实时打印 stdout 或 stderr，结束后仅显示最终安全摘要

### Requirement: 保持工具状态在唯一滚动区域内
工具状态 SHALL 作为对话内容的一部分参与现有实际显示行、滚动锚点和自动跟随计算。输入框、队列摘要和状态栏 SHALL 继续固定，系统 MUST NOT 为工具状态、工具详情或 Bash 输出创建第二个滚动区域或横向滚动条。

#### Scenario: 工具状态持续增加
- **WHEN** Agent Loop 产生多个模型回合和工具状态行
- **THEN** 所有内容只扩展现有对话滚动区，输入框与状态栏保持固定

#### Scenario: 查看上文时工具完成
- **WHEN** 用户已上滚查看历史且后台工具状态发生变化
- **THEN** 系统保持阅读锚点并把状态变化计入新增实际行提示，不强制跳到底部

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

### Requirement: 启动界面必须展示权限模式和真实能力

TUI SHALL 在启动状态中显示当前 `read_only | supervised | autonomous` 权限模式、工具配置意图、已认证 sandbox backend 和最终 Capability Report。工具配置为 enabled 但 backend 未认证时 MUST 显示工具不可用及原因，MUST NOT 暗示已获得宿主权限或提供 unsafe fallback。权限模式切换 SHALL 只对新 Task 生效；活动 Task 中不得热切换扩大权限。

#### Scenario: Windows backend 未认证
- **WHEN** 用户在不受支持的 Windows 版本以 tools enabled 启动
- **THEN** TUI 明确显示 sandbox unavailable，业务工具从能力清单移除，并提供继续纯文本或退出的选择

### Requirement: HITL 必须保持单页和唯一滚动区域

授权请求 SHALL 作为结构化事件插入现有唯一对话转录滚动区，展示 Gateway 生成的动作摘要、规范化资源、风险、完整能力清单、命中规则与数据目的地。当前待决项的操作控件 SHALL 复用固定底部操作栏，MUST NOT 创建模态弹窗、侧栏、嵌套列表滚动或第二滚动区域。长授权详情 SHALL 在主转录区折叠或展开，并继续由同一滚动状态管理。

#### Scenario: 多项授权详情超过屏幕
- **WHEN** 一个批次包含多个长路径和能力说明的 ask 项
- **THEN** 详情出现在唯一对话滚动区，底部操作栏保持固定，页面不存在第二个可滚动容器

### Requirement: 授权决定必须逐项且结构化

TUI SHALL 要求用户对每个 ask 项选择 `allow_once`、`allow_for_task` 或 `deny`，并 MAY 提供取消整个权限请求；Task 范围允许只可用于 Gateway 给出的窄范围。界面 MUST NOT 提供无范围 `allow_all`、session/permanent allow 或自然语言“确认”解析。提交 SHALL 包含完整 `taskId + runId + requestId + epoch + actionDigest` 和恰好覆盖所有待决项的决定集合。

#### Scenario: 用户允许一项并拒绝一项
- **WHEN** 同一授权请求包含两个 ask 动作
- **THEN** TUI 在提交前要求两项均有明确选择，并把逐项决定作为一个绑定当前请求的结构化动作发送

#### Scenario: 用户取消授权请求
- **WHEN** 用户选择取消而不是允许或拒绝各项
- **THEN** TUI 发送结构化取消，当前运行以 `PERMISSION_CANCELLED` 收尾且不把任何项记为明确拒绝

### Requirement: 授权等待期间普通输入必须保持 busy

当 ActiveRun 处于 `awaiting_authorization` 时，普通输入框 SHALL 不把文本排队、注入模型或解释为权限决定；界面 SHALL 清楚说明只能完成当前结构化决定或取消。用户原草稿 MAY 保留在本地输入缓冲，但 MUST NOT 改变授权 epoch 或 Pending Authorization。

#### Scenario: 等待授权时用户键入补充要求
- **WHEN** 用户在待授权状态编辑普通文本并尝试提交
- **THEN** TUI 保留草稿并提示当前 busy，不发送普通 turn，也不改变待决请求

### Requirement: 权限拒绝和完整性故障必须呈现不同状态

普通 deny、previously denied、sandbox capability unavailable 和正常票据过期 SHALL 显示为可重新规划的动作失败，并保持 Agent 运行进度；Security Integrity Failure SHALL 显示不可恢复安全终止、已撤销能力及“外部效果是否可能存在”的明确状态。界面 MUST NOT 用同一泛化工具错误混淆二者，也 MUST NOT 展示策略正文、票据、凭据或未授权数据。

#### Scenario: 用户拒绝写文件
- **WHEN** Agent 收到 `PERMISSION_DENIED` 后提出只读替代方案
- **THEN** TUI 先显示写入被拒绝，再继续显示同一 Task 的后续安全进度而不把 Task 标成崩溃

#### Scenario: 结果审计失败
- **WHEN** 动作可能已产生效果但结果审计无法持久化
- **THEN** TUI 显示安全终止和效果可能已发生，不向模型或终端展示未经审计的原始结果
