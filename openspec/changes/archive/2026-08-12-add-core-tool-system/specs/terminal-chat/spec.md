## MODIFIED Requirements

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

## ADDED Requirements

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
