# terminal-chat Specification

## Purpose

定义 Weave 面向用户的全屏终端对话体验，包括 Claude Code 风格的单页布局、小狗品牌标识、流式文本、输入按键、滚动与尺寸响应、安全渲染以及 Windows 和 WSL 验收边界。

## Requirements

### Requirement: 启动全屏终端对话界面
系统 SHALL 在配置、工作区和 Node.js 版本校验通过后进入全屏 TUI。首版运行时 SHALL 要求 Node.js 22 或更高版本，并 SHALL 提供 `--config`、`--profile`、`--workspace`、`--tools`、`--no-tools`、`--help` 和 `--version` 命令行选项。`--tools` 与 `--no-tools` MUST 互斥；`--workspace` 指定目录不存在或不是目录时 SHALL 在进入 TUI 前失败。工作区 MUST NOT 写入配置文件。

#### Scenario: 正常进入工具模式 TUI
- **WHEN** Node.js、配置和工作区均有效且工具最终解析为启用
- **THEN** 系统初始化六个工具和调度器，进入全屏终端界面并等待用户输入

#### Scenario: 正常进入纯文本 TUI
- **WHEN** 用户通过配置或 `--no-tools` 禁用工具
- **THEN** 系统不初始化工具与调度器，并沿用现有纯文本对话路径

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

#### Scenario: 未实现命令不可用
- **WHEN** 用户查看帮助或在 TUI 输入内容
- **THEN** 系统不宣称支持 `/model`、`/clear`、`/mcp` 或其他未实现的斜杠命令

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
