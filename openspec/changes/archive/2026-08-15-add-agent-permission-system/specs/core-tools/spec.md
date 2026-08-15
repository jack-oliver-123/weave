## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: 工具定义必须携带完整能力清单

每个核心工具定义 MUST 附带可由确定性规范化器生成的 Capability Manifest，覆盖该动作可能使用的全部文件读取、文件写入、进程、网络、凭据、数据披露和记忆持久化能力。未知、动态或无法精确确定的资源 MUST 使用更保守的能力范围并触发 ask 或 deny；工具实现和模型参数均不得把能力范围扩大到清单之外。

#### Scenario: 新增工具缺少网络能力声明
- **WHEN** 一个新核心工具的实现可发起网络请求但定义没有可验证的 `NetworkEgress`
- **THEN** 注册或启动认证失败，工具不会进入模型可见清单
