## Why

Weave 已能让模型读取、修改工作区并执行 Bash，但当前安全边界主要是提示词和初始工作目录：模型、项目内容或工具输出遭受 Prompt 注入后，业务工具仍可直接访问宿主文件、环境、网络和进程，且没有运行时授权、数据出口控制或人在回路。现在需要把权限判断、数据保护与 OS 强制隔离收敛为不可绕过的 Action Gateway，使动作被拒绝后 Agent 仍能重新规划，同时确保任何获准动作只在最小能力沙箱内执行。

## What Changes

- 新增 Task 级 Action Gateway Session，成为模型交换、业务工具、Memory 和未来远程能力的唯一安全入口；AgentLoop 只提交 `ModelExchangeRequest` 或不透明 `ProposalBatchReference`，不再直接持有模型客户端、工具执行器、原始 tool calls 或原始工具结果。
- 新增五层防线决策链：Command Risk Check、Path Capability Boundary、Permission Rules、Permission Mode、Authorization Confirmation；最终 allow 仍必须进入 OS Sandbox，Built-in Hard Denial 和路径边界不可被规则、模式或 HITL 覆盖。
- 新增封闭的 Capability Manifest、逐能力 allow coverage、`read_only | supervised | autonomous` 模式矩阵、批次预检、One-time/Task-scoped Grant、拒绝记忆、授权纪元和结构化 `Denied Result`；权限拒绝反馈模型继续规划，安全完整性故障才终止 Task。
- 新增同一 ActiveRun 内的 HITL 挂起与恢复协议。TUI 在唯一转录区展示 Gateway 生成的标准化动作、资源、风险和完整能力，并复用固定底部操作栏逐项决定，不增加弹窗、侧栏或第二滚动区域。
- 新增 Secure Context Ledger、Public Transcript、Provenance Envelope、Data Classification、Input Guard、Output Guard、Result Disclosure Action 和 Destination-bound Grant；项目指令、Plan、历史、Memory 与工具内容均作为不可信上下文，凭据不得进入模型、普通进程、历史或审计。
- 新增 Sandbox Supervisor、Task Sandbox 和逐动作 Action Worker。全部业务工具迁入 Runner；每个动作使用宿主签名、单次消费的 Capability Ticket 派生最小文件、进程和网络 profile，并强制资源预算、环境清空、进程树和 Fail Closed。
- 新增 Workspace Copy-on-write View、Workspace Commit Broker 与可恢复的 Transactional Action Change Set；写入在宿主提交前整批验证，使用持久化事务日志、逐路径原子替换、失败回滚与崩溃恢复，冲突时停止工具模式且不覆盖用户数据。
- 新增 Controlled Network Egress 与 Credential Broker；Sandbox 不拥有原始网络或凭据，网络目标、DNS 解析、重定向、TLS、私网地址和凭据代用范围均参与授权。
- 新增写前授权审计、Runner 执行记录和结果披露屏障；审计只保存摘要与关联状态，审计不可用时不得执行或披露未经记录的结果。
- 按只读文件、事务写入、进程、受控出口和 OS backend 独立交付并认证 Capability Slice；未运行、未知、跳过或不稳定的安全验证都不构成认证，也不提供 `--unsafe` 或宿主执行回退。
- **BREAKING**：AgentLoop 不再接收 `LlmClient + ToolExecutor + ChatMessage[]`，ConversationStore 不再是模型上下文真相源，模型与工具历史改由 Task 私有 Secure Context Ledger 管理。
- **BREAKING**：项目指令、Plan、路径、历史和 Memory 不再进入 `system`/SystemReminder；高优先级通道只容纳固定 Weave 协议和白名单结构化标量。
- **BREAKING**：六个核心工具不再在宿主进程直接执行。`bash` 不再继承宿主环境或原始网络；写工具不再直接替换宿主文件。
- **BREAKING**：Provider profile 不再接受明文 `api_key`；配置改为 Credential Reference，`${ENV}` 只作为弃用迁移通道并在下一 major 移除。

## Capabilities

### New Capabilities

- `action-authorization`: 定义 Action Gateway、标准化动作、五层防线、封闭能力、权限规则与模式、批次预检、HITL、授权范围、纪元、拒绝与完整性故障语义。
- `sandbox-execution`: 定义 Sandbox Supervisor、Task Sandbox、Action Worker、签名票据、OS backend、资源与进程隔离、工作区事务、受控网络、凭据代理和能力认证。
- `secure-context`: 定义 Secure Context Ledger、Public Transcript、来源与分类传播、Prompt 信任映射、Input/Output Guard、结果披露和目标绑定授权。
- `security-audit`: 定义授权与执行审计的数据最小化、写前持久化顺序、Runner 记录、结果屏障、保留策略和故障处理。

### Modified Capabilities

- `agent-task-execution`: AgentLoop 改为通过 Action Task Session 完成模型交换和动作批次，并在同一 Run 内挂起 HITL、消费 Denied Result 和区分安全完整性终止。
- `conversation-management`: 分离 Public Transcript 与 Secure Context Ledger，管理 Pending Authorization、结构化决定、Task 安全上下文生命周期及普通输入 busy 语义。
- `prompt-assembly`: 移除项目指令、Plan、路径、Memory 等自然语言的 system 提权，改为带来源的不可信上下文，并在最终请求前执行 Input Guard。
- `core-tools`: 六工具迁入 Sandbox Runner，文件访问使用 CoW 与 Commit Broker，Bash 使用最小环境、无原始网络和显式进程生命周期。
- `tool-execution`: 在调度前执行整批标准化与授权预检，使用 Proposal Batch Reference 和 Capability Ticket，并在结果披露后保持有序反馈与调用预算。
- `multi-protocol-llm`: 模型目标固定到 Task，三协议通过 Gateway 接收受保护上下文和能力裁剪定义，原始 tool calls/流输出不再直接暴露给 AgentLoop。
- `terminal-chat`: 增加权限模式、HITL 请求、逐项结构化决定、授权取消和安全错误状态，同时保持单页与唯一滚动区域。
- `continuous-integration-quality-gates`: 将确定性安全测试纳入基础 CI，并把需要真实 OS/特权的 backend 认证作为独立证据；未执行不得报告为通过。

## Impact

- 主要影响 `src/security/`、`src/engine/`、`src/tool/`、`src/memory/`、`src/config/`、`src/llm/`、`src/interaction/`、`src/shared/types.ts` 与 `src/main.ts`，并新增独立 Sandbox Runner、Broker、策略、审计和恢复组件。
- 配置新增 `~/.weave/security.yaml` 与 `<workspace>/.weave-policy.yaml`，Provider 密钥迁入 OS Credential Store；Task 启动时固定策略、模型目标、路径边界和资源预算。
- Linux/WSL2 与 Windows backend 独立实现和认证；缺少受支持 backend 时只允许纯文本或已经认证的更小能力集。
- 变更采用能力纵切片和 expand-contract 迁移，旧宿主执行路径在对应 Runner 切片通过前保持不可达，而不是作为兼容回退。
- 默认测试增加规则与模式契约、属性/模糊测试、数据泄露、票据攻击、事务故障注入、资源限制和 HITL E2E；真实 OS 负向探测单独生成 backend 认证证据。
- 本次不实现多用户/RBAC、租户隔离、`full_access`、任意插件自定义权限语义、通用网络代理、跨进程 Task 恢复、外部副作用回滚，或对已失陷宿主 OS、Weave 安装和 sandbox kernel escape 的防护。
