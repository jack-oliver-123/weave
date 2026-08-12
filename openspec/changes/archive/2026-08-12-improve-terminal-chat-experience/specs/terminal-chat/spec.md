## ADDED Requirements

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

## MODIFIED Requirements

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
- **WHEN** 输入框包含多行或自动折行文本
- **THEN** 布局按实际显示行调整输入框高度且不创建独立滚动区域

### Requirement: 提供可重复的跨终端验收
系统 SHALL 提供不访问真实 API 的确定性终端 E2E，并 SHALL 将真实协议 smoke 与默认测试分离。Windows 11 CMD 与 PowerShell/Windows Terminal SHALL 作为正式支持环境接受自动化终端验证，WSL2 Ubuntu SHALL 使用原生 `tmux` 验收；无法由 pane 文本观察的中文输入法候选窗位置 SHALL 通过可重复的 Windows 人工 smoke 验收。

#### Scenario: Windows 终端 E2E
- **WHEN** 在 Windows 执行确定性 TUI E2E
- **THEN** 自动化验证 CMD 与 PowerShell/Windows Terminal 下的启动布局、Markdown、实际行折行、按键、滚轮事件、队列、尺寸变化、单一滚动区域、单一标题和正常退出

#### Scenario: CMD 中文输入法 smoke
- **WHEN** 验收者在 Windows 11 CMD 中按规定步骤使用中文输入法编辑单行、多行、自动折行和 Unicode 混合文本
- **THEN** 候选窗跟随真实插入点、原生光标位置正确、经典 Console Host 的 `Ctrl+J` 与 Windows Terminal 1.25+ 的 `Shift+Enter` 可插入换行，且退出后终端状态恢复

#### Scenario: WSL 终端 E2E
- **WHEN** 在 WSL2 Ubuntu 执行确定性 TUI E2E
- **THEN** `tmux` 执行与 Windows 等价的 Markdown、布局、键盘滚动、队列和终端恢复场景；不宣称验证 Windows 输入法窗口

#### Scenario: 默认测试不使用真实 API
- **WHEN** 执行默认测试套件
- **THEN** 测试使用可控的假流客户端且不读取 `~/.weave/config.yaml`

#### Scenario: 三协议真实 smoke
- **WHEN** 显式执行 live smoke 并提供有效本地配置
- **THEN** Windows 对三种协议分别完成真实两轮流式对话，WSL 使用一个可用 profile 完成真实 TUI 两轮冒烟

## REMOVED Requirements

### Requirement: 流式显示纯文本回答
**Reason**: 回答展示从不解析 Markdown 的纯文本模式升级为渐进式 Markdown，同时必须保留原有流式状态、异常终态和部分回答语义。

**Migration**: 使用“渐进式显示 Markdown 回答”要求替代；原始安全文本仍作为渲染输入和对话历史内容，现有 LLM 流事件契约不变。
