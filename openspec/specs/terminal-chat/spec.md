# terminal-chat Specification

## Purpose

定义 Weave 面向用户的全屏终端对话体验，包括 Claude Code 风格的单页布局、小狗品牌标识、流式文本、输入按键、滚动与尺寸响应、安全渲染以及 Windows 和 WSL 验收边界。

## Requirements

### Requirement: 启动全屏终端对话界面
系统 SHALL 在配置和 Node.js 版本校验通过后进入全屏 TUI。首版运行时 SHALL 要求 Node.js 22 或更高版本，并 SHALL 只提供 `--config`、`--profile`、`--help` 和 `--version` 命令行选项。

#### Scenario: 正常进入 TUI
- **WHEN** Node.js 版本与选中 profile 均有效
- **THEN** 系统进入全屏终端界面并等待用户输入

#### Scenario: Node.js 版本过低
- **WHEN** 运行时版本低于 Node.js 22
- **THEN** 系统在进入全屏模式前输出中文版本错误并以非零状态退出

#### Scenario: 配置启动失败
- **WHEN** 配置文件不存在、无法解析或 profile 无效
- **THEN** 系统不进入全屏模式，不启动配置向导，并在普通终端输出脱敏的中文诊断

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

### Requirement: 流式显示纯文本回答
TUI SHALL 按 turn 逐段追加 assistant 文本，保留 Unicode、换行、制表符和代码围栏文本，但 SHALL 不解析 Markdown。小狗标识 SHALL 保持静态，生成状态 SHALL 单独显示等待、生成、完成、截断、拒答、中断或错误及响应耗时。

#### Scenario: 等待首个文本片段
- **WHEN** turn 已开始但尚未收到文本
- **THEN** 回答区域显示旋转等待状态且小狗标识不重绘动画

#### Scenario: 流式追加文本
- **WHEN** TUI 收到多个 `text_delta`
- **THEN** 文本按事件顺序显示并更新“生成中 · <耗时>”状态

#### Scenario: 正常完成
- **WHEN** TUI 收到正常完成事件
- **THEN** 状态固定为“完成 · <耗时>”且回答留在对话区

#### Scenario: 截断或拒答完成
- **WHEN** TUI 收到截断完成或有文本拒答结果
- **THEN** 回答保留并分别显示“已达到输出上限”或“模型拒绝回答”标记

#### Scenario: 取消部分回答
- **WHEN** 用户取消已有部分文本的 turn
- **THEN** 部分文本保留在对话区并显示“已中断”标记

### Requirement: 支持明确的输入与退出按键
输入框 SHALL 支持多行文本，`Enter` SHALL 提交，`Shift+Enter` SHALL 插入换行，多行粘贴 SHALL 保持原始换行。生成期间输入框 SHALL 继续允许编辑，但 SHALL 禁止提交第二条消息。

#### Scenario: 提交单轮输入
- **WHEN** 输入框包含非空文本且用户按下 `Enter`
- **THEN** 系统提交该文本并开始新的 turn

#### Scenario: 插入换行
- **WHEN** 用户按下 `Shift+Enter`
- **THEN** 输入框在当前光标位置插入换行且不提交

#### Scenario: 生成期间编辑
- **WHEN** assistant 正在生成且用户输入新草稿
- **THEN** 草稿保持可编辑，但按下提交键不得创建并发 turn

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
TUI SHALL 只让对话区滚动，输入框和状态栏 SHALL 固定且不得产生第二滚动条。流式输出 SHALL 默认跟随底部；用户手动上滚后 SHALL 暂停自动跟随，回到底部后 SHALL 恢复。

#### Scenario: 自动跟随流式输出
- **WHEN** 用户位于对话底部且收到新文本
- **THEN** 对话区保持显示最新文本

#### Scenario: 阅读历史时暂停跟随
- **WHEN** 用户手动上滚后收到新文本
- **THEN** 系统保持当前阅读位置且不强制跳到底部

#### Scenario: 返回底部恢复跟随
- **WHEN** 用户滚回对话底部
- **THEN** 后续流式文本再次自动跟随

#### Scenario: 输入内容增长
- **WHEN** 输入框包含多行或自动换行文本
- **THEN** 布局调整输入框高度但不创建独立滚动区域

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
系统 SHALL 提供不访问真实 API 的确定性终端 E2E，并 SHALL 将真实协议 smoke 与默认测试分离。Windows 11 PowerShell/Windows Terminal SHALL 使用 `psmux` 验收，WSL2 Ubuntu SHALL 使用原生 `tmux` 验收。

#### Scenario: Windows 终端 E2E
- **WHEN** 在 Windows 执行确定性 TUI E2E
- **THEN** `psmux` 验证启动布局、两轮流、按键、滚动、尺寸变化、单一标题和正常退出

#### Scenario: WSL 终端 E2E
- **WHEN** 在 WSL2 Ubuntu 执行确定性 TUI E2E
- **THEN** `tmux` 执行与 Windows 等价的交互场景

#### Scenario: 默认测试不使用真实 API
- **WHEN** 执行默认测试套件
- **THEN** 测试使用可控的假流客户端且不读取 `~/.weave/config.yaml`

#### Scenario: 三协议真实 smoke
- **WHEN** 显式执行 live smoke 并提供有效本地配置
- **THEN** Windows 对三种协议分别完成真实两轮流式对话，WSL 使用一个可用 profile 完成真实 TUI 两轮冒烟
