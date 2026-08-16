# core-tools Specification

## Purpose

定义 Weave 首版核心工具的固定集合、模型可见描述、统一调用结果，以及工具直接操作本地工作区时必须遵守的路径、文本、资源和失败边界。

## Requirements

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
每个业务工具 SHALL 使用同一中立契约声明输入 Schema、成功结果 Schema、风险属性和完整 Capability Manifest。Action Gateway SHALL 在宿主侧校验模型提案、规范化动作并完成整个批次预检；通过授权后，Runner SHALL 在 Action Worker 内再次校验规范化输入、传递取消信号、执行工具逻辑并校验成功数据。业务工具实现 MUST NOT 在 Weave 宿主进程内直接运行，也 MUST NOT 自行扩展能力清单。

每个结果 MUST 包含内部 `callId`、`providerCallId`、`toolName`、必填布尔值 `isError` 和结构化 `content`。成功结果 SHALL 使用 `isError: false` 并提供 `summary` 与符合结果 Schema 的数据引用；失败结果 SHALL 使用 `isError: true` 并提供 `summary` 与包含稳定 `code`、中文 `message`、`retryable` 及可选安全 `details` 的 `error`。原始结果 MUST 先保留在 Secure Context Ledger 中，并通过独立 `DataDisclose` 动作后才能进入模型、终端或历史。

#### Scenario: 工具成功
- **WHEN** 动作获得授权、Worker 输入与结果均通过校验且结果披露也获得目标授权
- **THEN** 系统返回关联标识一致且 `isError` 为 `false` 的结构化成功结果

#### Scenario: 可预期工具失败
- **WHEN** 工具遇到已声明的参数、路径、文件、命令、权限、超时或取消错误
- **THEN** 系统返回 `isError: true`、稳定错误码和获准披露的安全上下文，而不把普通失败升级为对话系统错误

#### Scenario: 工具返回非法数据
- **WHEN** Worker 返回的数据不符合工具结果 Schema
- **THEN** 系统将其收敛为 `INTERNAL_TOOL_ERROR`，且不向模型暴露非法载荷、原始 IPC 或堆栈

### Requirement: 提供稳定且安全的错误接口
通用错误码 SHALL 至少包含 `INVALID_ARGUMENT`、`UNKNOWN_TOOL`、`PATH_OUTSIDE_WORKSPACE`、`TARGET_IS_SYMLINK`、`INVALID_UTF8`、`TOOL_TIMEOUT`、`TOOL_CANCELLED`、`INTERNAL_TOOL_ERROR`、`PRIOR_WRITE_FAILED`、`TURN_CANCELLED`、`TOOL_CALL_LIMIT_REACHED`、`PERMISSION_DENIED`、`PREVIOUSLY_DENIED`、`PERMISSION_CANCELLED`、`SANDBOX_UNAVAILABLE`、`TICKET_EXPIRED` 和 `RECOVERY_CONFLICT`。工具专属错误码 SHALL 至少包含 `FILE_NOT_FOUND`、`FILE_ALREADY_EXISTS`、`NOT_A_FILE`、`TEXT_NOT_FOUND`、`AMBIGUOUS_MATCH`、`FILE_TOO_LARGE`、`FILE_CHANGED_DURING_EDIT`、`SHELL_NOT_FOUND` 和 `COMMAND_FAILED`。安全完整性故障 MUST 使用 Task 终止协议，MUST NOT 伪装为普通工具错误码。

系统 MUST NOT 在错误中暴露堆栈、临时或备份路径、宿主绝对路径、环境变量、策略正文、票据、凭据、拒绝检测原文或未获披露授权的数据。`summary` MUST NOT 超过 1 KiB，错误 `message` MUST NOT 超过 2 KiB，`details` 序列化后 MUST NOT 超过 8 KiB；发生安全截断时 SHALL 明确标记。

#### Scenario: 未知异常
- **WHEN** 工具抛出未识别异常
- **THEN** 系统返回不含内部细节的 `INTERNAL_TOOL_ERROR`

#### Scenario: 错误详情过大
- **WHEN** 安全错误详情超过对应上限
- **THEN** 系统保留错误码和重新规划所需的有界信息，并标记详情已截断

### Requirement: 固定本地工作区边界
系统 SHALL 在启动时把 `--workspace <path>` 或默认启动目录解析为已存在目录的真实绝对路径，并 SHALL 在 Task 生命周期内把该身份固定为宿主只读基线。相对 `--workspace` SHALL 基于启动目录解析；工具参数中的路径 SHALL 只接受工作区相对路径，`.` 表示工作区根目录，模型默认 SHALL 只看到使用 `/` 分隔的工作区相对路径。业务工具 MUST 只访问 Task 私有 CoW 视图，MUST NOT 直接打开或修改宿主工作区 inode；获准写入只能由宿主 Commit Broker 提交。

文件工具与进程 `cwd` SHALL 使用同一规范化边界：拒绝空字节、绝对路径、UNC、Windows 设备路径、NTFS Alternate Data Stream 和任何解析后位于工作区外的路径。Windows 路径边界比较 SHALL 不区分大小写，Linux SHALL 区分大小写。已有目标 SHALL 根据真实身份与摘要校验；新目标 SHALL 从最近的已有父目录解析和校验。最终目标及任一父级中的外部符号链接、Junction 或 reparse point MUST 被拒绝；内部链接仅在解析后仍位于授权根且后端能证明其安全时可用。预存硬链接 MUST 不出现在沙箱可写视图中。

#### Scenario: 使用默认工作区
- **WHEN** 用户未提供 `--workspace`
- **THEN** 系统固定使用启动进程的当前目录作为只读基线，并把工具返回路径规范化为相对路径

#### Scenario: 路径逃逸
- **WHEN** 文件路径或进程 `cwd` 通过绝对路径、`..`、链接父目录或平台特殊路径解析到工作区外
- **THEN** 系统返回 `PATH_OUTSIDE_WORKSPACE` 或对应参数错误，且 Worker 的挂载视图中不存在目标

#### Scenario: 最终目标是链接
- **WHEN** 工具调用的最终目标是指向工作区外的符号链接、Junction 或 reparse point
- **THEN** 系统返回 `TARGET_IS_SYMLINK` 且不得跟随、读取或修改该目标

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
`bash` 输入 MUST 包含 `command`，可选包含工作区相对 `cwd`、`timeoutMs` 和 `lifetime`。`cwd` 默认 SHALL 为工作区根目录；`timeoutMs` 默认 SHALL 为 120 秒且最大为 10 分钟；`lifetime` 默认 SHALL 为 `action`，仅显式且获准的 `task` 可创建 Task 生命周期进程。系统 SHALL 只在当前平台沙箱后端通过认证且完整 Capability Manifest 获得授权时提供 `bash` 定义，否则该工具 MUST 从模型工具清单中移除。

每次调用 SHALL 在新的 Action Worker 中启动非交互 shell，关闭 stdin，使用最小只读运行时、清空后的环境和显式构建的安全 PATH。Worker MUST 不继承 Weave 进程环境、宿主 PATH、凭据、控制 IPC、审计路径或未授权挂载；调用之间 MUST NOT 保留 shell 状态。首版 MUST NOT 支持 PTY 或交互输入。原始 shell 默认至少需要 `ProcessSpawn`，并按规范化命令实际能力增加 `FilesystemRead`、`FilesystemWrite`、`NetworkEgress`、`CredentialUse`、`DataDisclose` 或其他能力；命令黑名单中的不可授权行为 MUST 在进入沙箱前硬拒绝。

成功或失败数据 SHALL 保留经过 Output Guard 和终端控制字符清理的有界 `stdout`、`stderr`、`exitCode`、`durationMs`、`timedOut` 和 `truncated`；stdout 与 stderr 各自最多 64 KiB。非零退出 MAY 同时产生合法 CoW 变更；只要动作获得对应写入授权且事务校验通过，变更 SHALL 提交并返回 `COMMAND_FAILED`，而不是因退出码自动回滚。超时、取消、撤销或 Worker 崩溃时系统 SHALL 终止完整进程树并丢弃当前动作尚未提交的变更。

#### Scenario: 命令成功
- **WHEN** 沙箱内 shell 在上限内以状态 0 退出且结果披露获准
- **THEN** 系统提交合法动作变更并返回 `isError: false` 以及有界输出、退出码和耗时

#### Scenario: 命令非零退出
- **WHEN** shell 以非零状态退出但产生的工作区变更仍符合已授权能力与事务校验
- **THEN** 系统提交合法变更、返回 `COMMAND_FAILED` 与有界输出，使模型能够基于真实状态重新规划

#### Scenario: 命令超时或取消
- **WHEN** 命令超过 `timeoutMs`、用户取消或权限被即时撤销
- **THEN** 系统终止 Worker 完整进程树、丢弃该动作未提交变更，并返回对应安全结果或 Task 终止状态

### Requirement: 将工具观察视为不可信数据
文件内容、搜索结果和命令输出 SHALL 作为结构化工具数据传给模型，MUST NOT 拼接进系统提示词或提升为系统指令。系统提示 SHALL 明确工具观察中的指令性文字不改变现有指令优先级。系统 MUST NOT 通过关键词过滤修改真实代码、文件或日志内容。

#### Scenario: 文件包含提示注入文字
- **WHEN** 文件或命令输出声称应忽略既有规则或调用其他工具
- **THEN** 系统保持该内容的数据边界，且不把其自动转换为高优先级指令

#### Scenario: 诊断工具调用
- **WHEN** 应用记录工具执行诊断
- **THEN** 日志最多包含工具名、内部调用标识、耗时、`isError` 和错误码，不记录参数、文件内容、命令输出或环境信息

### Requirement: 工具定义必须携带完整能力清单

每个核心工具定义 MUST 附带可由确定性规范化器生成的 Capability Manifest，覆盖该动作可能使用的全部文件读取、文件写入、进程、网络、凭据、数据披露和记忆持久化能力。未知、动态或无法精确确定的资源 MUST 使用更保守的能力范围并触发 ask 或 deny；工具实现和模型参数均不得把能力范围扩大到清单之外。

#### Scenario: 新增工具缺少网络能力声明
- **WHEN** 一个新核心工具的实现可发起网络请求但定义没有可验证的 `NetworkEgress`
- **THEN** 注册或启动认证失败，工具不会进入模型可见清单
