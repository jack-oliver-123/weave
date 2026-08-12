## Context

见 `proposal.md` 的 Why。当前 `formatTranscript` 将每个逻辑行转换为字符串，`visibleViewportLines` 也只按数组元素计数，但 Ink 会根据终端宽度再次自动折行，因此视口偏移与真实屏幕行会在长文本、Markdown 缩进和宽字符场景下失配。输入框高度只统计显式换行，光标则通过在字符串中插入 `█` 模拟，终端真实光标仍由 Ink 留在输出末端，导致 CMD 输入法候选窗出现在页面右下角。

现有 `ConversationController` 已保证单活动 turn 和稳定终态，消息队列不需要进入引擎层。Ink 7 已提供专门面向 IME 的 `useCursor`；当前依赖中没有 Markdown AST、GFM 或直接 Unicode 显示宽度能力。模型与用户文本仍必须先经过现有安全清理，任何解析和高亮都不得重新信任模型提供的 ANSI。

## Goals / Non-Goals

**Goals:**

- 建立 Markdown、纯文本、表格、代码块、输入框和视口共用的实际显示行模型。
- 在流式更新期间保持已完成块稳定，并让滚动阅读位置不因重解析或新增内容跳动。
- 使用 Ink 原生光标能力修复 IME 定位，同时保留终端自身光标样式。
- 在交互层实现可观测、可撤回且始终串行的进程内消息队列。
- 让终端模式启用与清理成对执行，退出后不残留鼠标跟踪、光标或 alternate-screen 状态。

**Non-Goals:**

- 不修改 LLM 流协议、`ConversationController` 的单 turn 约束或消息存储契约。
- 不渲染用户输入中的 Markdown，不执行原始 HTML，不加载远程图片或链接内容。
- 不增加输入历史、队列持久化、会话恢复、斜杠命令或队列列表编辑器。
- 不引入横向滚动区域，也不为输入框创建第二个可见滚动条。

## Decisions

### 1. 使用 GFM AST，而不是正则替换 Markdown

引入 `unified`、`remark-parse` 与 `remark-gfm`，将清理后的 assistant 原文解析为带源位置的 AST，再由 Weave 自己映射为终端语义块。这样可以覆盖嵌套列表、任务列表、表格、链接、代码围栏和行内样式，并避免正则替换在嵌套与流式边界上的歧义。

每个 turn 保留原始安全文本作为事实来源。生成期间按 Ink 的渲染帧合并文本增量，缓存已经稳定的块；解析器根据块级 token 与源位置区分稳定前缀和未闭合尾段。稳定块只在宽度变化时重新布局，尾段在闭合前产生纯文本块；收到终态后对完整原文做一次最终解析。解析失败时该 turn 退化为安全纯文本，不影响历史或其他 turn。

替代方案是直接使用终端 Markdown 整体渲染库，但其输出通常已经扁平化为 ANSI 字符串，难以保留语义锚点、响应式表格和实际行滚动；手写 Markdown 解析则会重复解决成熟解析器已覆盖的问题。

### 2. 先产生语义块，再统一布局为显示行

新增与 React 组件无关的中间模型：语义块包含块类型、源范围、缩进、样式 span 和稳定锚点；布局器接收语义块与可用列宽，输出 `DisplayRow[]`。对话视口只消费 `DisplayRow`，不再让 Ink 隐式折行后再猜测高度。每一行使用稳定的 `turnId + sourceRange + visualRow` 标识，使流式追加时可以保持顶部阅读锚点。

使用 `Intl.Segmenter` 按字素移动输入光标，并将 `string-width` 声明为直接依赖来计算 CJK、Emoji、组合字符和 ANSI 安全样式的显示列。用户和 assistant 的长文本、列表续行、表格单元格、代码续行、队列预览与 composer 共用同一折行/截断原语。输入框达到高度上限后只显示以光标为中心的窗口并提供边界提示，不暴露第二个滚动条。

替代方案是继续以换行符数组作为视口单位并依赖 Ink `wrap`，但它无法可靠映射鼠标滚轮步长、未读行数、调整宽度后的阅读位置或真实光标坐标。

### 3. 表格与代码块在布局层响应终端宽度

表格先计算各列最小宽度、内容宽度与间距。总宽度可容纳时输出对齐行；否则每个数据行输出一组“列名：内容”，保留表头语义而不产生横向滚动。空表头、超长单元格和宽字符都走统一折行算法。

代码块保留逻辑行与缩进，显示可用语言标签。`cli-highlight` 仅处理已经清理的代码文本；其输出只允许由 Weave 生成的 SGR 样式进入渲染，未知语言或无颜色环境直接返回纯文本。超宽逻辑行按可用宽度视觉折行，续行前放置弱化 `↪`，该标记只属于展示模型，不写回会话历史。

替代方案是截断代码或提供横向滚动，但前者会隐藏内容，后者违反单滚动区域约束。

### 4. 使用 Ink `useCursor` 定位真实光标

composer 不再插入 `█`。组件根据统一显示行模型计算光标相对 Ink 输出的 `x/y`，并通过 Ink 7 的 `useCursor().setCursorPosition` 在每次提交帧后定位。坐标以字素边界和显示列计算，终端尺寸过小时隐藏光标，恢复布局后重新定位；卸载时交还 Ink 处理光标与终端清理。

这优于直接向 `stdout` 写 `cursorTo`：手工 escape 容易与 Ink 的差量渲染竞争，而 `useCursor` 正是 Ink 为 IME 场景提供的提交后光标接口。Weave 不发送改变光标形状、颜色或闪烁的控制序列。

Windows 多行快捷键按终端能力分层处理。Weave 通过 Ink 自动协商 Kitty Keyboard Protocol；Windows Terminal 1.25+ 支持该协议时可区分 `Shift+Enter` 与 `Enter`。经典 Console Host 实测两者都只产生 `0d`，应用无法可靠区分，因此保留 `Ctrl+J`（`0a`）作为插入换行的兼容路径。普通 `Enter` 在两类终端中始终提交。

### 5. 在终端边界规范化滚轮事件

扩展终端模式控制器，在交互 TTY 支持时成对启用/禁用标准鼠标跟踪与 SGR 坐标模式。输入适配器必须在 composer 之前识别完整滚轮序列，将其转换为 `scroll_up`/`scroll_down` 动作并吞掉原始控制字符；不识别或不完整的鼠标序列不得插入输入框。键盘 `PageUp`、`PageDown` 和 `Ctrl+End` 保持为无鼠标环境的等价路径。

视口由“距底部行数”升级为稳定行锚点加未读实际行数。位于底部时新行自动跟随；离开底部时保持锚点并累计新增行，滚回底部后清零。滚轮坐标不用于命中不同区域，因此终端任意位置的滚轮都只驱动唯一对话视口。

经典 Windows Console Host、Windows Terminal 和 `tmux` 对鼠标协议的支持不同，先用独立终端探针验证启停序列、事件格式和清理行为，再接入 TUI。若目标 CMD 主机不能产生标准序列，适配器在 Windows 层提供等价事件来源；不得以保留 `PageUp` 为由将正式 CMD 滚轮验收降级为可选。

### 6. 消息队列是交互层状态机

在 `TuiState` 中增加队列项、`active/paused` 状态和最近反馈，不改变引擎端口。生成期间 `Enter` 将完整 composer 值原子加入队尾并清空 composer；当前 turn 只有在 `completed` 时才触发自动续发。续发先对队列做不可变快照，按 `\n\n` 合并并清空已消费项，再调用现有 `consumeTurn`，从而避免重复提交。

`truncated`、`refused`、`cancelled` 与 `error` 都把队列置为 `paused`。暂停时 `Enter` 是显式恢复：若 composer 非空，先追加再发送；否则直接发送现有队列。自动续发永远不读取或清空未入队 composer 草稿。

`Ctrl+Z` 只撤销最近一次入队：弹出队尾并恢复到 composer；若 composer 已有未入队草稿，则用一个空行连接恢复内容与现有草稿，确保两者都不丢失。队列摘要只占一行，使用显示宽度安全截断显示“数量 + 最新预览”。队列非空时第一次 `Ctrl+C` 保留数据并显示丢失数量，第二次仍按现有两秒窗口退出。

队列状态变化集中在纯 reducer 中，异步提交循环只消费 reducer 产生的单个 effect，防止 React state、ref 与 `ConversationController.activeTurnId` 之间形成竞态。

### 7. 分层验证终端能力

单元测试覆盖 Markdown 分片边界、降级路径、Unicode 宽度、表格/代码布局、显示行锚点、composer 光标和队列状态机。Ink 集成测试覆盖样式结构、固定区域和真实光标坐标。Windows/WSL 确定性 E2E 使用假流客户端，不访问真实 API；通过注入标准滚轮序列验证自动滚动行为，并用 `cmd.exe` 与 PowerShell 启动入口分别运行。

OS 输入法候选窗不是 pane 文本的一部分，自动化断言不能证明其位置，因此新增固定步骤的 Windows 11 CMD 人工 smoke：分别输入中文单行、多行、自动折行和中英 Emoji 混合文本，记录候选窗跟随与退出恢复结果。自动 E2E 通过不等于 IME gate 通过，最终验证报告必须分别列出。

## Risks / Trade-offs

- [流式 Markdown 在任意分片处都可能暂时不完整] → 只提交解析器确认的稳定块，尾段纯文本回退，并用字符级分片测试覆盖围栏、链接、强调和表格。
- [每个增量重解析和重排长回答会造成卡顿] → 按 Ink 帧合并增量，缓存稳定 AST 与显示行，只重算活动尾段；宽度变化才重排完整文档。
- [Unicode 显示宽度会随终端字体和 Emoji 策略不同] → 使用 `string-width` 与字素分割作为统一基线，并在 CMD、Windows Terminal 和 WSL 用同一夹具校准差异。
- [语法高亮产生的 ANSI 与不可信模型 ANSI 混淆] → 在解析前清理所有输入 ANSI，高亮阶段只放行内部生成的 SGR 样式，其他控制序列一律拒绝。
- [鼠标跟踪可能影响终端原生选择或退出后残留] → 仅在交互全屏生命周期内启用，所有正常/异常退出路径成对关闭，并保留键盘滚动。
- [自动队列可能在用户未预期时续发] → 只有正常完成自动续发，其他终态暂停；固定摘要、撤回和退出警告保持队列状态可见。
- [真实 CMD 输入法无法完全自动化] → 把人工 smoke 作为独立必过 gate，不用快照测试替代 OS 级候选窗验证。
- [经典 Console Host 丢失 `Shift+Enter` 的 Shift 修饰信息] → 现代 Windows Terminal 自动协商增强键盘协议，经典 Console Host 使用可区分的 `Ctrl+J` 换行，并在 Windows E2E 中覆盖该真实字节路径。

## Migration Plan

1. 先加入显示行、Markdown、队列和终端输入的纯模型及夹具，不切换现有 TUI。
2. 用终端探针验证 Windows 11 CMD、PowerShell/Windows Terminal 与 WSL 的滚轮协议、真实光标和清理能力。
3. 将转录与 composer 切换到统一显示行模型，并保留安全纯文本降级路径。
4. 接入 Markdown、滚轮、`useCursor` 和队列状态机，扩展确定性 E2E 与人工 IME smoke。
5. 完成聚焦测试、全量测试、跨终端 gate 和严格 OpenSpec 验证后再归档。

回滚时移除新渲染和输入适配器，恢复纯文本显示、键盘滚动与原 composer；该变更不迁移持久化数据，也不改变会话协议，因此无需数据回滚。

## 实现依赖检查

- 项目要求 Node.js `>=22.0.0`；`unified@11`、`remark-parse@11`、`remark-gfm@4` 与 `string-width@8` 均以 ESM 方式加载，符合当前 `NodeNext` 构建边界。
- `cli-highlight@2` 为 CommonJS 包；Node.js 22 可从当前 ESM/NodeNext 项目安全导入，已由类型检查、构建和跨终端夹具验证。
- `unified`、`remark-parse`、`remark-gfm` 与 `string-width` 使用 MIT 许可证，`cli-highlight` 使用 ISC 许可证；两类宽松许可证均与本项目当前分发方式兼容。
