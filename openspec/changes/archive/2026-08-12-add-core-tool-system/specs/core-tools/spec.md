## Purpose

定义 Weave 首版核心工具的固定集合、模型可见描述、统一调用结果，以及工具直接操作本地工作区时必须遵守的路径、文本、资源和失败边界。

## ADDED Requirements

### Requirement: 注册固定且不可变的核心工具集合
系统 SHALL 在工具启用时注册且仅注册 `read_file`、`create_file`、`edit_file`、`bash`、`glob`、`grep` 六个工具，并 SHALL 在模型请求开始前完成定义校验和运行期冻结。首版 MUST NOT 支持动态增删、MCP、插件或用户自定义工具。

每个工具定义 SHALL 包含英文机器名称、中文 `purpose`、中文 `useWhen`、中文 `avoidWhen`、JSON Schema `inputSchema`、JSON Schema `resultSchema`、`worksWith` 和由系统声明的 `executionMode`。工具名称 MUST 匹配 `^[a-z][a-z0-9_]{0,63}$`，`useWhen` 与 `avoidWhen` MUST 各至少包含一项，`worksWith` MUST 只引用已注册工具。`executionMode` MUST 为 `read_shared` 或 `write_exclusive`，其中三个读取工具使用前者，三个可能产生副作用的工具使用后者。

#### Scenario: 完成启动注册
- **WHEN** 工具功能启用且六个工具定义、Schema 和交叉引用全部有效
- **THEN** 系统暴露一个运行期不可变的六工具集合，并允许按名称列出和分发单个调用

#### Scenario: 注册定义无效
- **WHEN** 工具名称重复、字段缺失、Schema 无效、执行模式非法或 `worksWith` 引用不存在的工具
- **THEN** 系统在启动阶段失败且不得发送任何模型请求

#### Scenario: 拒绝动态工具
- **WHEN** 运行期尝试增加、删除或替换工具定义或实例
- **THEN** 系统拒绝修改并保持启动时的工具集合不变

### Requirement: 生成完整且有界的模型可见工具说明
系统 SHALL 以固定字段顺序把每个中立工具定义转换为模型可见说明，且 SHALL 完整表达做什么、什么时候使用、什么时候不使用、参数约束、返回格式以及与其他工具的配合方式。机器标识 SHALL 使用英文，说明文字和 Schema 参数描述 SHALL 使用中文，且不得根据当前用户输入语言动态改变。

单个生成后说明 MUST NOT 超过 8 KiB，单个输入或结果 Schema 序列化后 MUST NOT 超过 32 KiB，六个工具定义整体 MUST NOT 超过 256 KiB；任何超限 SHALL 在启动阶段失败，不得在请求时静默裁剪。

#### Scenario: 生成等价说明
- **WHEN** 任一模型协议读取已注册工具定义
- **THEN** 每个工具的模型可见说明完整包含全部六类信息且语义与中立定义一致

#### Scenario: 定义体积超限
- **WHEN** 任一说明、Schema 或工具集合超过固定体积上限
- **THEN** 系统以工具定义错误终止启动且不生成不完整说明

### Requirement: 统一校验调用并包装工具结果
每个工具 SHALL 使用同一通用执行契约校验输入、传递 `AbortSignal`、执行核心逻辑、校验成功数据并包装结果。JSON Schema SHALL 是参数与成功数据的运行时事实来源，所有对象默认 SHALL 拒绝未声明字段。

每个结果 MUST 包含内部 `callId`、`providerCallId`、`toolName`、必填布尔值 `isError` 和结构化 `content`。成功结果 SHALL 使用 `isError: false` 并提供 `summary` 与符合该工具 `resultSchema` 的 `data`；失败结果 SHALL 使用 `isError: true` 并提供 `summary` 与包含稳定 `code`、中文 `message`、`retryable` 及可选安全 `details` 的 `error`。`retryable` SHALL 表示使用相同参数原样重试是否可能成功。

#### Scenario: 工具成功
- **WHEN** 输入通过校验、工具正常执行且成功数据符合结果 Schema
- **THEN** 系统返回关联标识一致且 `isError` 为 `false` 的结构化成功结果

#### Scenario: 可预期工具失败
- **WHEN** 工具遇到已声明的参数、路径、文件、命令、超时或取消错误
- **THEN** 系统返回 `isError: true`、稳定错误码和有助于模型调整策略的安全上下文，而不把工具失败升级为对话系统错误

#### Scenario: 工具返回非法数据
- **WHEN** 工具实现返回的数据不符合自己的结果 Schema
- **THEN** 系统将其收敛为 `INTERNAL_TOOL_ERROR`，且不向模型暴露非法载荷或堆栈

### Requirement: 提供稳定且安全的错误接口
通用错误码 SHALL 至少包含 `INVALID_ARGUMENT`、`UNKNOWN_TOOL`、`PATH_OUTSIDE_WORKSPACE`、`TARGET_IS_SYMLINK`、`INVALID_UTF8`、`TOOL_TIMEOUT`、`TOOL_CANCELLED`、`INTERNAL_TOOL_ERROR`、`PRIOR_WRITE_FAILED`、`TURN_CANCELLED` 和 `TOOL_CALL_LIMIT_REACHED`。工具专属错误码 SHALL 至少包含 `FILE_NOT_FOUND`、`FILE_ALREADY_EXISTS`、`NOT_A_FILE`、`TEXT_NOT_FOUND`、`AMBIGUOUS_MATCH`、`FILE_TOO_LARGE`、`FILE_CHANGED_DURING_EDIT`、`SHELL_NOT_FOUND` 和 `COMMAND_FAILED`。

系统 MUST NOT 在错误中暴露堆栈、临时文件路径、工作区绝对路径或环境变量。`summary` MUST NOT 超过 1 KiB，错误 `message` MUST NOT 超过 2 KiB，`details` 序列化后 MUST NOT 超过 8 KiB；发生安全截断时 SHALL 明确标记。

#### Scenario: 未知异常
- **WHEN** 工具抛出未识别异常
- **THEN** 系统返回不含内部细节的 `INTERNAL_TOOL_ERROR`

#### Scenario: 错误详情过大
- **WHEN** 安全错误详情超过对应上限
- **THEN** 系统保留错误码和重新规划所需的有界信息，并标记详情已截断

### Requirement: 固定本地工作区边界
系统 SHALL 在启动时把 `--workspace <path>` 或默认启动目录解析为已存在目录的真实绝对路径，并 SHALL 在进程生命周期内固定该工作区。相对 `--workspace` SHALL 基于启动目录解析；工具参数中的路径 SHALL 只接受工作区相对路径，`.` 表示工作区根目录，模型默认 SHALL 只看到使用 `/` 分隔的工作区相对路径。

文件工具与 `bash.cwd` SHALL 使用同一解析边界：拒绝空字节、绝对路径、UNC、Windows 设备路径、NTFS Alternate Data Stream 和任何解析后位于工作区外的路径。Windows 路径边界比较 SHALL 不区分大小写，Linux SHALL 区分大小写。已有目标 SHALL 根据真实路径校验；新目标 SHALL 从最近的已有父目录解析和校验。

最终目标 MUST NOT 是符号链接或 Junction；搜索 MUST NOT 返回符号链接文件或进入链接目录。父目录可以包含链接或 Junction，但其真实路径 MUST 仍位于工作区内。`bash` 只约束初始 `cwd`，MUST NOT 对命令正文执行路径、网络或进程访问分析。

#### Scenario: 使用默认工作区
- **WHEN** 用户未提供 `--workspace`
- **THEN** 系统固定使用启动进程的当前目录，并把工具返回路径规范化为相对路径

#### Scenario: 路径逃逸
- **WHEN** 文件路径或 `bash.cwd` 通过绝对路径、`..`、链接父目录或平台特殊路径解析到工作区外
- **THEN** 系统返回 `PATH_OUTSIDE_WORKSPACE` 或对应的参数错误，且不得访问目标

#### Scenario: 最终目标是链接
- **WHEN** 工具调用的最终目标是符号链接或 Junction
- **THEN** 系统返回 `TARGET_IS_SYMLINK` 且不得跟随或修改该目标

### Requirement: 读取有界的 UTF-8 文本文件
`read_file` SHALL 读取工作区内普通文本文件。输入 MUST 包含 `path`，可选包含从 1 开始的 `startLine` 与正整数 `lineCount`。系统 SHALL 接受 UTF-8 和带 UTF-8 BOM 的文本，返回内容 SHALL 移除 BOM、保留原始换行，并 SHALL 拒绝二进制或非法 UTF-8。

单次返回内容 MUST NOT 超过 64 KiB；超限时 SHALL 返回已有内容、`truncated: true` 和可用的 `nextStartLine`。成功数据 SHALL 包含相对 `path`、`content`、`startLine`、`endLine`、`totalLines`、`truncated` 和适用时的 `nextStartLine`，且 `content` MUST NOT 混入行号。默认执行上限 SHALL 为 10 秒。

#### Scenario: 读取指定行范围
- **WHEN** 模型提供有效文件路径、`startLine` 和 `lineCount`
- **THEN** 系统返回对应 UTF-8 原文范围及准确的行号和总行数元数据

#### Scenario: 文件内容过长
- **WHEN** 请求范围的内容超过 64 KiB
- **THEN** 系统返回有用的截断成功结果，并提供继续读取所需信息

#### Scenario: 文件不是有效文本
- **WHEN** 目标为二进制或非法 UTF-8 文件
- **THEN** 系统返回 `INVALID_UTF8` 或等价的稳定文本类型错误且不返回原始字节

### Requirement: 安全创建新的 UTF-8 文本文件
`create_file` 输入 MUST 包含 `path` 和 `content`，内容 MUST NOT 超过 1 MiB。系统 SHALL 按需递归创建缺失父目录，使用无 BOM UTF-8 且保留输入换行，并 SHALL 以同目录临时数据和原子、排他的发布方式创建目标。目标已存在时 MUST 返回 `FILE_ALREADY_EXISTS` 且不得覆盖。

成功数据 SHALL 包含相对路径、写入字节数和本次创建的父目录列表。失败时系统 SHALL 尽力清理临时数据及本次创建的空目录，但 MUST NOT 删除原有目录。该工具 MUST NOT 设置自定义权限、创建链接或写入二进制内容。

#### Scenario: 创建文件及父目录
- **WHEN** 目标不存在、内容有效且部分父目录缺失
- **THEN** 系统原子创建父目录和完整文件，并返回实际创建信息

#### Scenario: 并发创建同一路径
- **WHEN** 检查后另一个进程先创建了相同目标
- **THEN** 系统仍返回 `FILE_ALREADY_EXISTS` 且不得覆盖或留下半写入目标

### Requirement: 通过唯一精确匹配原子编辑文本文件
`edit_file` 输入 MUST 包含 `path` 和 1 至 100 个按顺序声明的 `{oldText, newText}` 编辑项。`oldText` MUST 为非空文本，`newText` 可以为空；`oldText` 与 `newText` 相同时 SHALL 返回 `INVALID_ARGUMENT`。目标 MUST 是工作区内已存在、不超过 1 MiB 的 UTF-8 普通文件。

系统 SHALL 在内存副本中依次应用编辑，后项基于前项结果匹配；每个 `oldText` 在当时内容中 MUST 唯一出现。零次匹配 SHALL 返回 `TEXT_NOT_FOUND`，多次匹配 SHALL 返回 `AMBIGUOUS_MATCH`，任何编辑失败 SHALL 保持磁盘文件原样。全部编辑成功后系统 SHALL 原子替换文件，保留 UTF-8 BOM 状态、未修改内容、换行和文件权限，并返回路径、替换数量及编辑前后字节数。

系统 SHALL 在读取时记录文件身份、大小、修改时间和内容哈希，并 SHALL 在落盘前重新校验；外部进程在此期间修改、替换或删除目标时 MUST 返回 `FILE_CHANGED_DURING_EDIT` 且不得自动重试。首版 MUST NOT 支持模糊匹配、通用 Patch 或整文件覆写。

#### Scenario: 顺序执行多个编辑
- **WHEN** 每个 `oldText` 在对应中间内容中均唯一匹配
- **THEN** 系统一次性原子提交全部替换并保持其他内容不变

#### Scenario: 任一编辑不唯一
- **WHEN** 任一编辑在对应中间内容中零次或多次匹配
- **THEN** 整个调用失败且磁盘文件不发生部分修改

#### Scenario: 编辑期间文件变化
- **WHEN** 外部进程在读取和提交之间改变了目标身份或内容
- **THEN** 系统返回 `FILE_CHANGED_DURING_EDIT`，提示模型重新读取后规划

### Requirement: 以稳定语义匹配工作区文件路径
`glob` 输入 MUST 包含一个非空且不超过 4 KiB 的 `pattern`，可选包含默认值为 `.` 的 `path`。模式 SHALL 相对于 `path` 匹配，只接受 `/` 分隔符，并支持 `*`、`**`、`?`、字符组和花括号展开；MUST NOT 接受绝对模式、`..`、否定模式列表或反斜杠分隔符。

系统 SHALL 只返回普通文件，默认不匹配未显式写出的点路径段，并 SHALL 始终排除 `.git/**` 与 `node_modules/**`。结果 SHALL 使用工作区相对 `/` 路径并按字典序稳定排序，最多返回 1,000 项；无匹配 SHALL 是空列表成功结果。默认执行上限 SHALL 为 30 秒，扫描最多 100,000 个文件；达到结果或扫描上限时 SHALL 返回 `truncated: true` 和对应原因，而不是把已有结果改为错误。

#### Scenario: 匹配项目文件
- **WHEN** 模型提供有效模式和可选搜索路径
- **THEN** 系统返回稳定排序的匹配普通文件且不包含固定排除目录

#### Scenario: 没有匹配
- **WHEN** 有效模式未匹配任何文件
- **THEN** 系统返回 `isError: false` 的空结果

#### Scenario: 达到扫描上限
- **WHEN** 搜索检查到 100,000 个文件后仍未结束
- **THEN** 系统停止扫描并返回已有结果以及 `reason: "scan_limit"`

### Requirement: 逐行搜索工作区文本内容
`grep` 输入 MUST 包含非空、单行且不超过 4 KiB 的 `pattern`，可选包含 `path`、文件 `glob` 和默认值为 `true` 的 `caseSensitive`。系统 SHALL 执行不跨行的字面量子串搜索，MUST NOT 把输入解释为正则表达式；大小写不敏感匹配 SHALL 使用不依赖系统区域设置的 Unicode 规则。同一行多次命中 SHALL 只返回一项。

每项结果 SHALL 包含工作区相对路径、从 1 开始的行号和移除末尾换行但保留其他空白的匹配行；单项文本 MUST NOT 超过 500 个字符，整体最多返回 1,000 项，并 SHALL 先按路径再按行号稳定排序。系统 SHALL 跳过二进制、非法 UTF-8、链接、`.git` 和 `node_modules`；单个文件不可读 SHALL 记录安全 `warnings` 而不使整个搜索失败。无匹配 SHALL 是空列表成功结果。

默认执行上限 SHALL 为 30 秒，扫描最多 100,000 个文件；达到结果或扫描上限 SHALL 返回有用的截断成功结果。首版 MUST NOT 支持正则、上下文行或内容替换。

#### Scenario: 找到多文件匹配
- **WHEN** 多个文本文件包含给定字面量
- **THEN** 系统返回有界、稳定排序且包含相对路径和行号的匹配结果

#### Scenario: 跳过不可读文件
- **WHEN** 搜索范围内一个文件不可读而其他文件可正常搜索
- **THEN** 系统继续返回其他结果，并在 `warnings` 中记录安全诊断

#### Scenario: 大小写不敏感搜索
- **WHEN** `caseSensitive` 为 `false`
- **THEN** 系统以跨平台一致的 Unicode 大小写规则执行字面量匹配

### Requirement: 在独立非交互 Bash 中执行命令
`bash` 输入 MUST 包含 `command`，可选包含工作区相对 `cwd` 和 `timeoutMs`。`cwd` 默认 SHALL 为工作区根目录；`timeoutMs` 默认 SHALL 为 120 秒且最大为 10 分钟。系统 SHALL 在 Windows 从 `PATH` 查找 `bash.exe`，在 WSL 或 Linux 使用 `bash`，找不到时返回 `SHELL_NOT_FOUND`。

每次调用 SHALL 启动独立的 `bash --noprofile --norc -c` 非交互进程，关闭 stdin，继承当前进程环境和 `PATH`，设置 `PWD` 为校验后的工作目录并设置 `CI=1`。调用之间 MUST NOT 保留 `cd`、变量或 Shell 状态；首版 MUST NOT 支持 PTY、交互输入、持久 Shell 或后台任务管理。

成功或失败数据 SHALL 保留经过终端控制字符清理的 `stdout`、`stderr`、`exitCode`、`durationMs`、`timedOut` 和 `truncated`；`stdout` 与 `stderr` 各自最多 64 KiB。非零退出、超时或取消 SHALL 返回 `isError: true`，但 MUST 保留已有输出。超时或取消时系统 SHALL 终止整个子进程树。命令正文访问工作区外文件、网络或进程的能力不受本次工具边界限制。

#### Scenario: 命令成功
- **WHEN** Bash 在上限内以状态 0 退出
- **THEN** 系统返回 `isError: false` 以及有界输出、退出码和耗时

#### Scenario: 命令非零退出
- **WHEN** Bash 以非零状态退出
- **THEN** 系统返回 `COMMAND_FAILED`、`isError: true`，并保留有界 stdout 与 stderr 供模型重新规划

#### Scenario: 命令超时或取消
- **WHEN** 命令超过 `timeoutMs` 或用户取消当前 turn
- **THEN** 系统终止子进程树并返回对应错误及终止前的有界输出

### Requirement: 将工具观察视为不可信数据
文件内容、搜索结果和命令输出 SHALL 作为结构化工具数据传给模型，MUST NOT 拼接进系统提示词或提升为系统指令。系统提示 SHALL 明确工具观察中的指令性文字不改变现有指令优先级。系统 MUST NOT 通过关键词过滤修改真实代码、文件或日志内容。

#### Scenario: 文件包含提示注入文字
- **WHEN** 文件或命令输出声称应忽略既有规则或调用其他工具
- **THEN** 系统保持该内容的数据边界，且不把其自动转换为高优先级指令

#### Scenario: 诊断工具调用
- **WHEN** 应用记录工具执行诊断
- **THEN** 日志最多包含工具名、内部调用标识、耗时、`isError` 和错误码，不记录参数、文件内容、命令输出或环境信息
