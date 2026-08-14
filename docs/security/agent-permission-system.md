# Agent 权限与沙箱架构

状态：设计已确认，尚未实施

日期：2026-08-14

## 1. 目标

本设计同时处理三类风险：

1. 不可信自然语言通过 Prompt 注入改变 Agent 行为或伪造授权。
2. Agent、模型或工具执行超出用户允许范围的动作。
3. 工作区、工具、模型或凭据数据被披露到未授权出口。

安全目标不是让模型正确判断权限，而是让模型、项目内容和工具代码即使行为恶意，也无法绕过宿主 Action Gateway 与 OS Sandbox。

## 2. 信任模型

可信计算基包括：宿主 OS、Weave 宿主安全层和已安装代码、结构化用户授权、经过认证的 Sandbox backend。以下内容一律不可信：模型输出、用户和项目自然语言、Plan、工作区文件、依赖与工具进程、网页、MCP、hook、plugin、Memory 和外部服务返回。

自然语言只能提出动作，不能授予权限。授权来源仅包括：

- 工作区外且通过所有权、ACL 和文件身份验证的用户安全策略。
- 显式选择并固定到 Task 的 Permission Mode。
- Action Gateway 生成请求后取得的结构化 Authorization Confirmation。

不处理宿主 root/kernel/hypervisor、Weave 安装或可信配置已经失陷的情况，也不保证用户在看见准确信息并明确批准后不会后悔业务结果。

## 3. 总体架构

```text
TUI / ConversationManager
        |
        | Task Action + released events
        v
Action Task Session
  +------------------------------------------------------+
  | Action Gateway                                       |
  |  - Secure Context Ledger / Public Transcript boundary|
  |  - Input Guard / Output Guard                        |
  |  - normalization / policy / mode / HITL              |
  |  - audit / tickets / proposal custody                |
  +------------------------------------------------------+
        |                         |
        | fixed Model Destination | signed Capability Ticket
        v                         v
  Model Adapter             Sandbox Supervisor
                                  |
                            Task Sandbox
                                  |
                            Action Worker
                                  |
             +--------------------+--------------------+
             |                    |                    |
       Commit Broker        Network Broker       Credential Broker
```

Action Gateway 是所有模型数据交换、文件、进程、网络、持久化和未来远程能力的唯一安全 Seam。AgentLoop 不直接持有 LlmClient、ToolExecutor、Sandbox Runner 或原始工具结果。

## 4. 外部 Interface

```ts
interface ActionGateway {
  openTask(spec: OpenActionTask): Promise<ActionTask>;
}

interface ActionTask {
  perform(
    request: GatewayRequest,
    signal: AbortSignal,
  ): AsyncGenerator<GatewayEvent, GatewayResult>;

  resolveAuthorization(
    confirmation: AuthorizationConfirmation,
  ): void;

  close(reason: TaskCloseReason): Promise<void>;
}

type GatewayRequest =
  | ModelExchangeRequest
  | ActionBatchRequest;
```

`openTask` 固定 Task 的 Policy Snapshot、Permission Mode、Model Destination、Path Capability Boundary、Task Resource Budget、Authorization Epoch 和 Task Sandbox。`close` 幂等，并撤销票据与 Task-scoped Grant、终止进程树、销毁 Task Sandbox 和 Secure Context Ledger；已提交副作用不回滚。

### 4.1 模型交换

Model Exchange Request 只引用 Gateway 管理的上下文和可信运行态。Input Guard 组装并二次扫描最终请求，模型只可调用 Task 创建时固定的 profile、协议、模型部署和 origin；禁止重定向、provider/profile fallback 或在 Task 中途切换目标。

模型原始 tool calls 留在 Gateway。Model Exchange Result 只返回已获准文本、Safe Action Descriptor 和 Proposal Batch Reference。

### 4.2 动作批次

Action Batch Request 只接受绑定 `taskId + runId + iteration + modelExchangeId + authorizationEpoch + batchDigest` 的短时单次 Proposal Batch Reference，不接受任意 tool call payload。模型、Memory、MCP、hook 和 plugin 的动作只能由 Gateway 内受信、版本化 Adapter 生成提案批次。

一个 Action Proposal 必须标准化为一个不可拆分的 `Normalized Action + Capability Manifest`。若操作可以独立授权，模型必须提出多个 Action Proposal。工具执行后的内容披露始终形成新的 Result Disclosure Action。

## 5. 五层防线决策链

每个标准化动作按固定顺序处理：

```text
1. Command Risk Check
2. Path Capability Boundary
3. Permission Rules
4. Permission Mode
5. Authorization Confirmation
6. OS Sandbox execution
```

前两层的拒绝不可覆盖。Permission Rules 先于 Permission Mode；只有 `ask` 进入 HITL。应用层 `allow` 只表示可以进入 OS 强制执行，不表示 Sandbox 可选。

### 5.1 Command Risk Check

Built-in Hard Denial 只覆盖稳定安全不变量：破坏安全控制面或沙箱、宿主设备或安全策略访问、提权、原始 IPC、凭据披露、宿主级灾难、工作区根灾难性删除和资源炸弹。一般高风险操作产生 `ask`，未命中规则绝不等于允许。

Prompt Injection 检测只增加风险。可疑内容触发的副作用或数据出口至少为 `ask`，除非工作区外存在精确 allow 规则；检测器不产生 allow，也不能替代运行时边界。

### 5.2 Path Capability Boundary

可信配置在启动时固定只读和读写工作区根。HITL 不能挂载新路径或扩大根；新增根必须创建新 Task 或修改工作区外配置。相对路径、符号链接、reparse point、硬链接、设备路径和文件身份必须在宿主与 Runner 两侧重新验证。

### 5.3 Permission Rules

规则使用版本化、声明式、无代码、无正则、无否定和无顺序语义的类型化 schema。文件规则使用根和 glob；结构化进程规则使用不可变可执行身份、参数前缀与能力子集；Raw Shell allow 必须匹配完整脚本摘要和能力范围；网络规则匹配协议、目标和端口；数据规则匹配来源、分类、用途和目标出口。

用户规则可产生 `allow | ask | deny`。项目 `.weave-policy.yaml` 只能产生 `ask | deny`。全部匹配按 `deny > ask > allow > no_match` 合并，不受加载顺序影响。

`deny/ask` 命中动作或任一能力即可收紧完整动作。`allow` 只为明确匹配的单项 Capability Requirement 提供 Allow Coverage；多条可信规则可以共同覆盖完整 Manifest，未覆盖部分交给其他规则或 Permission Mode。动作名称不能隐式放行网络、凭据或数据出口。

### 5.4 Permission Mode

模式只为未被规则覆盖的能力提供默认值：

| Capability | `read_only` | `supervised` | `autonomous` |
|---|---:|---:|---:|
| 普通 FilesystemRead | allow | allow | allow |
| FilesystemWrite | deny | ask | allow |
| 本地结构化 ProcessSpawn | deny | ask | allow |
| Raw Shell / 高风险进程 | deny | ask | ask |
| NetworkEgress | deny | ask | ask |
| CredentialUse | deny | ask | ask |
| MemoryPersist | deny | ask | ask |
| 普通数据到固定模型/终端 | allow | allow | allow |
| Sensitive Data 披露 | ask | ask | ask |
| Credential Data 披露 | hard deny | hard deny | hard deny |

不提供 `full_access`。精确可信 allow 规则可以覆盖模式默认值，但不能覆盖 Built-in Hard Denial、路径边界或 OS Sandbox。

### 5.5 Capability Manifest 与最终裁决

首版能力原语是：

```text
FilesystemRead
FilesystemWrite
ProcessSpawn
NetworkEgress
CredentialUse
DataDisclose
MemoryPersist
```

动作级裁决和每项能力裁决按 `deny > ask > allow` 合并。任一 deny 拒绝完整动作，任一 ask 让完整动作进入 HITL，只有全部 allow 才签发 Capability Ticket。HITL 不能批准能力子集，执行后不能补充 Manifest。Workspace Commit 是 FilesystemWrite 的内部机制，不单独索权；设备、原始 IPC、提权和宿主安全策略修改不属于可授权能力。

## 6. 批次、HITL 与 AgentLoop

一个模型响应中的全部业务动作必须先完成 Batch Authorization Preflight，任一动作开始前已知整批结果。所有 ask 在唯一转录区集中展示，但用户逐项决定；不提供无范围的 allow all。允许的共享读可以并行，写操作保持顺序，前序写失败或拒绝时跳过依赖写。

Authorization Request 必须展示 Gateway 生成的标准化动作、真实资源、完整能力、风险、目标和授权范围。模型理由仅是非可信辅助文本。无法生成足以知情授权的安全展示时拒绝动作。

```ts
type ResolveAuthorizationAction = {
  type: 'resolve_authorization';
  taskId: string;
  runId: string;
  requestId: string;
  authorizationEpoch: number;
  decisions: readonly AuthorizationDecision[];
};
```

`perform()` 在发出请求后保持原 ActiveRun 和异步流挂起。挂起期间只接受匹配决定或取消，普通用户输入仍为 busy。决定必须逐项覆盖待决动作，且绑定 `taskId + runId + requestId + authorizationEpoch + actionDigest`；缺失、额外、过期或重复决定不得改变当前等待。

明确拒绝形成 Denied Result，计入调用与迭代预算并返回 AgentLoop，Agent 可以重新规划，Task 不自动停止。相同标准化动作在当前 Task 中形成 Task-scoped Denial，不重复询问。取消授权交互属于 Authorization Interruption，只取消当前 Run，不形成明确拒绝记忆。

One-time Grant 绑定精确 call。Task-scoped Grant 绑定 Task 和 Gateway 生成的窄范围；新自然语言输入、回答或 Plan revision 推进 Authorization Epoch，撤销旧 Task grant 与票据，Task-scoped Denial 保留。Plan Approval 只批准计划版本，不授予任何动作能力。

TUI 在现有转录中追加授权事件，并复用固定底部操作栏；不得增加 Modal、侧栏或第二滚动区域。

## 7. 数据与 Prompt 安全

### 7.1 Secure Context Ledger

Public Transcript 只保存允许在本地显示的脱敏用户文本、模型文本和安全摘要，用于 TUI，不是模型上下文真相源。Task 私有 Secure Context Ledger 保存内容引用、Provenance Envelope、Data Classification、授权状态、模型原始输出、动作提案和工具原始结果。

用户输入先进入临时缓冲。Credential Data 被移除并只留下无内容占位，原始缓冲立即销毁；当前用户任务正文未获准时不调用模型。Task 结束时销毁 Ledger，跨 Task 内容必须经过 MemoryPersist。Public Transcript 在新 Task 中重新摄取时只能是不可信、已脱敏上下文，不能恢复授权或降低分类。

### 7.2 Prompt Trust Mapping

system 或等价 developer 通道只包含版本固定、记录摘要的 Weave 行为协议、安全不变量、控制工具协议，以及白名单枚举和数字。受信 Tool Catalog 通过 Provider 工具定义通道提供 Capability Shaping 后的 schema。

用户输入、Project Instructions、Plan、Public Transcript、Memory、路径和工作区内容是带来源的不可信 user 上下文；工具、网页和 MCP 返回使用 tool 通道，但仍是不可信数据。授权裁决、规则详情和 Capability Ticket 不进入模型。任何自然语言、路径、文件名、profile 名或外部字符串不得插入 system。

### 7.3 分类传播

分类按 `credential > sensitive > ordinary` 单调合并。透明宿主变换取全部输入的最高分类；模型、Shell、进程和未知扩展是不透明变换，输出继承其可读输入的最高分类。可信 Adapter 可以把不含输入内容的退出码、计数和布尔状态单独分类；无法证明隔离时按最高分类。

用户批准一次 DataDisclose 只授权精确内容、用途和目标，不改变分类，也不传递到模型、网络、终端、历史、审计或文件等其他出口。Sensitive Content Task Grant 绑定内容摘要、来源、用途和固定 Model Destination，只允许精确重发；派生内容重新授权。Credential Data 永远不能通过普通出口，只能由 Credential Broker 代用。

Output Guard 在模型片段进入终端或历史前执行增量分类和目标授权。普通内容可在安全缓冲后流式释放；Sensitive Data 暂停对应出口，Credential Data 阻断并停止显示。工具原始结果先形成 Result Disclosure Action，拒绝时只向模型提供无内容安全摘要。

## 8. Sandbox Runner

### 8.1 生命周期分层

Sandbox Supervisor 是可信控制面，验证 Gateway 身份和 Capability Ticket，维护 Task Sandbox，并为每个动作创建 Action Worker。Task Sandbox 跨多个 Run 保存 Workspace Copy-on-write View、资源账本及获准的 task-lifetime 进程。Action Worker 按单个动作创建，不能访问策略、审计库、凭据、签名材料或 Supervisor 控制通道。

进程默认 `lifetime: action`，动作结束时终止完整 Authorized Process Tree。开发服务器等必须显式声明 `lifetime: task`，默认 ask；获准后始终保持创建时的 Action Sandbox Profile，不能继承后续权限。即时收权、Task 结束或完整性故障会终止全部长驻进程。

Runner 环境使用最小、确定性 allowlist，不继承宿主环境、SSH agent、代理变量或密钥。所有后代只能继承相同或更窄的文件、网络和资源限制。业务工具全部在 Runner 内执行，宿主 Agent 不直接读取工作区、启动工具进程或访问工具网络。

### 8.2 控制面与票据

Runner Control Channel 不监听 TCP，使用当前用户专属并验证对等身份的本地 IPC。Gateway 每次启动生成临时 Ed25519 密钥对；私钥留在宿主，Supervisor 只持有公钥。

Capability Ticket 至少绑定：

```text
schemaVersion
runnerId + sandboxId
taskId + runId + callId
actionDigest + capabilityManifestDigest
policySnapshotVersion + revocationVersion
authorizationEpoch
nonce + issuedAt + expiresAt
```

Supervisor 重新标准化动作并派生 profile，核对摘要后在启动 Worker 前原子消费 nonce。签名无效、身份或摘要不匹配、nonce 重放是 Security Integrity Failure；正常过期或收权返回结构化拒绝并重新预检。Worker 不接收原始票据。

### 8.3 Backend

- Linux 与 WSL2：使用 bubblewrap 或等价 mount/user/PID/network namespace backend；隐藏宿主路径，只绑定需要的运行时与工作区视图。WSL2 不暴露 `/mnt/c`、Windows PATH、interop socket 或 Windows 可执行入口。
- Windows 11 24H2+：优先使用 Windows Sandbox CLI 的 Task 级 VM，并在 guest 内为每个动作使用独立低权限身份与 Job。
- WSL1、旧版 Windows、macOS 或无法证明所需隔离的平台：对应能力不可用，只保留纯文本或已认证的更小能力集。

Node Permission Model、cwd 校验、Job Object、restricted token、seccomp 或 Landlock 单独使用都不是完整边界；它们只能作为 backend 的附加约束。

Sandbox Capability Report 必须验证 Runner 身份，并主动探测路径不可见、原始网络关闭、环境和设备不可读、不能提权、资源限额和进程树终止、IPC 受限以及 Broker 未被挂载。未知、缺失或本应失败的探测成功都 Fail Closed。

## 9. Workspace 写入事务

工具只写 Task 私有 CoW 层，不直接修改宿主 inode。动作结束后，Workspace Commit Broker 获取完整 diff，验证所有路径均在 Capability Manifest 内，并重新检查基线文件身份与摘要。预存在工作区的外部符号链接、reparse point、设备和硬链接文件不可用；内部链接也必须保持在已授权根内。

Transactional Action Change Set 使用以下状态：

```text
PREPARED -> APPLYING -> COMMITTED -> CLEANED
```

Broker 在工作区提交锁内使用同卷 staging、用户专属 ACL 备份、持久化日志和逐路径原子 replace/rename。不存在 COMMITTED 标记的崩溃事务恢复执行前状态，已 COMMITTED 的事务只完成清理。路径必须匹配日志 pre-state 或 post-state；其他状态进入 Workspace Recovery Conflict，停止工具模式、保留现场且只提供只读报告和用户确认的恢复操作。

Weave 动作不会观察部分提交，但不承诺外部编辑器看不到跨文件切换的短暂中间状态。动作非零退出但产生合法变更时仍可提交；当前动作取消、Worker 崩溃、收权、越界变化或冲突会丢弃全部未提交变化，先前动作的提交不回滚。网络副作用不属于文件事务。

## 10. 网络与凭据

Task Sandbox 没有原始网络。工具网络只能经过 Controlled Network Egress Broker，并按 scheme、规范化 host、port、实际 DNS 地址和操作匹配授权。必须使用 TLS；重定向或 origin 变化产生新动作。loopback、私网、VPN、link-local、metadata、保留地址和本地 socket 默认拒绝，其中宿主 metadata 和安全控制地址硬拒绝。HITL 只能批准具体目标，不能打开 raw network。

Credential Broker 在 Sandbox 外持有秘密，只按已授权 Credential Reference、目标和操作代表工具完成认证。Sandbox、模型、日志和普通错误不能看到原始值。不支持 broker 方式的认证失败关闭。

Provider 配置只保存 Credential Reference。原始凭据使用 Windows Credential Manager、Linux Secret Service 或 WSL 宿主代理；CLI 通过隐藏输入或 stdin 设置、删除和列出标识。明文 `api_key` 拒绝；`${ENV}` 只作为宿主迁移通道弃用，并在下一 major 移除。

## 11. 配置与策略生命周期

```text
~/.weave/config.yaml          Provider 与模型配置
~/.weave/security.yaml        可信用户策略、默认模式、预算、凭据引用
<workspace>/.weave-policy.yaml 项目 restrict-only 规则
```

用户安全策略必须为当前用户所有，不允许宽泛写入、删除或 ACL 修改权限，不允许 symlink、reparse point、设备或网络共享，并以打开后的 handle、文件身份和摘要验证。无法证明可信的 `--security-config` 或工作区内安全配置只按项目 restrict-only 规则处理。项目策略必须是固定根下的普通文件，不向父目录发现；多根工作区合并全部 restrict-only 规则，任一无效规则阻止对应能力启动。

Task 固定 Policy Snapshot 和 Permission Mode。项目或用户策略的扩权只对新 Task 生效；宿主 deny 和撤销版本可以立即收权、撤销票据并取消在途进程。已经完成的副作用不回滚。

## 12. 资源预算

Task 创建时固定预算，HITL 不能提高。默认上限：

- CPU：宿主 50%，最多 4 核。
- RAM：宿主 50%，最多 4 GiB。
- PID：128。
- 动作：默认 120 秒，单次最多 600 秒。
- Task 长驻进程：60 分钟。
- 临时区与工作区增长：4 GiB。
- stdout/stderr：各 64 KiB。
- 单批释放结果：512 KiB。
- 网络：每 Task 512 MiB。

产品硬上限为 8 核、16 GiB、512 PID、Task 4 小时、磁盘 32 GiB 和网络 4 GiB。只有工作区外用户策略可以在产品上限内调整，项目策略只能降低。

## 13. 审计与错误模型

审计保存在工作区外、使用当前用户专属 ACL，默认保留 30 天或 100 MiB，配置范围 1-365 天、最大 1 GiB；不上传，Agent 无权读取、导出或清理。记录只含关联 ID、摘要、风险、分类、规则、模式、决定、票据、sandbox 和结果状态，不含 Prompt、参数正文、文件内容、stdout/stderr 或凭据。

预检和 HITL 决定必须在签票前 durable flush；Supervisor 在消费 nonce 前写最小执行记录。执行结果必须跨过 Outcome Audit Barrier 后才能披露。同一批只读动作可合并 flush。预执行审计失败阻止动作；副作用后结果审计失败会收权、终止 Task、报告副作用可能已发生，并禁止向模型释放结果。Workspace 事务日志独立于审计。

普通安全结果包括策略或路径拒绝、敏感披露拒绝、资源超限、Workspace 冲突、票据正常过期和 Sandbox 能力不足。它们以结构化 `isError` 返回并允许 AgentLoop 重新规划。

Security Integrity Failure 包括票据伪造、摘要不匹配或重放，Runner 身份或隔离失效，Gateway 绕过，审计、策略或凭据完整性失效，以及无法恢复的 Workspace 事务。它们会终止 Run、撤销票据、终止进程并销毁 Task Sandbox，不作为普通工具错误继续。

## 14. 渐进交付

1. 安全内核：Gateway、Ledger、规则与模式、HITL、数据守卫、审计和配置；仅纯文本。
2. 只读文件：read_file、glob、grep。
3. 事务写入：create_file、edit_file 与完整恢复。
4. 进程：结构化进程、Raw Shell、进程树与资源限制。
5. 受控出口：Network Egress、Credential Broker、MemoryPersist。
6. Backend 独立认证：Linux/WSL2 与 Windows 分别启用。

每个 Capability Slice 默认关闭，只有应用裁决、OS 强制、结果披露、审计、验收测试和主动负向探测全部通过后才能显示。不存在 `--unsafe`、宿主执行 fallback 或跳过沙箱的发布模式。

## 15. 能力认证

每个切片必须覆盖：

- 五层顺序、规则覆盖、模式矩阵、批次预检、HITL 和 Denied Result 后继续。
- 标准化幂等、路径与规则属性测试和模糊测试。
- chunk 边界凭据、分类传播和全部出口隔离。
- 目标 OS 上的路径逃逸、链接、宿主环境、设备、原始网络、提权和 sandbox 逃逸负向探测。
- 票据篡改、过期、重放、Runner 身份替换、IPC 越权和授权纪元失效。
- 提交、审计、Runner 和披露各阶段的故障注入与恢复。
- CPU、内存、PID、时间、输出、磁盘、网络预算和后代进程终止。
- 唯一滚动区中的真实 HITL、逐项决定、过期、取消及同 Run 恢复。

普通 CI 运行确定性测试。特权 backend 测试生成独立认证证据；未运行、平台不支持、未知、跳过或不稳定都不算通过。运行时 Sandbox Capability Report 仍然必需。

## 16. 当前代码迁移点

- `src/security/index.ts`：移除同步 `authorize()` stub，建立 Action Gateway Module 及内部策略、数据和票据组件。
- `src/engine/conversation-manager.ts`：Task 创建时 openTask；维护 Pending Authorization；分离 Public Transcript；Task 终态 close。
- `src/engine/agent-loop.ts`：不再直接调用 LlmClient 或 ToolExecutor；使用 Model Exchange Request、Proposal Batch Reference 和 Action Batch Request；Denied Result 保持下一轮。
- `src/tool/executor.ts` 与 `src/tool/scheduler.ts`：调度语义迁入 Gateway/Runner 后方，任何 registry dispatch 前必须有完整预检和票据。
- `src/tool/core-tools.ts` 与 Workspace：宿主工具实现迁移到 Action Worker 与 Broker，移除直接 `spawn('bash')` 和宿主文件访问路径。
- `src/memory/conversation-store.ts`：转为 Public Transcript；新增 Task 私有 Secure Context Ledger，跨 Task 写入走 MemoryPersist。
- `src/shared/types.ts`：新增 Gateway、动作、能力、授权、事件、错误与 Task 状态契约；Plan Approval 保持独立。
- `src/interaction`：在唯一转录区呈现 Authorization Request，固定底部栏提交结构化决定，不增加第二滚动区域。
- `src/main.ts`：启动时验证配置、凭据、Runner 身份、backend 能力和恢复事务；无法认证时只启用纯文本或已认证能力。

## 17. ADR 索引

- [ADR-0001：使用 Task 级 Action Gateway Session](../adr/0001-use-task-scoped-action-gateway.md)
- [ADR-0002：使用封闭的能力原语词汇](../adr/0002-use-closed-capability-vocabulary.md)
- [ADR-0003：Allow 规则必须逐能力覆盖](../adr/0003-require-explicit-allow-coverage.md)
- [ADR-0004：Permission Mode 只提供保守默认值](../adr/0004-define-permission-mode-defaults.md)
- [ADR-0005：HITL 保持原 ActiveRun 挂起](../adr/0005-suspend-active-run-for-hitl.md)
- [ADR-0006：Task Sandbox 内使用逐动作 Worker](../adr/0006-use-per-action-sandbox-workers.md)
- [ADR-0007：Runner 控制面使用身份验证与签名票据](../adr/0007-authenticate-runner-control-plane.md)
- [ADR-0008：工作区变更使用可恢复事务提交](../adr/0008-use-transactional-workspace-commits.md)
- [ADR-0009：派生内容保守继承数据分类](../adr/0009-propagate-data-classification.md)
- [ADR-0010：模型动作提案由 Action Gateway 保管](../adr/0010-keep-model-proposals-inside-gateway.md)
- [ADR-0011：公开转录与安全模型上下文分离](../adr/0011-separate-transcript-from-secure-context.md)
- [ADR-0012：模型通道按内容信任级别固定映射](../adr/0012-map-prompt-content-by-trust.md)
- [ADR-0013：先持久化审计再执行和披露](../adr/0013-audit-before-execution-and-disclosure.md)
- [ADR-0014：权限系统按能力切片渐进交付](../adr/0014-deliver-security-by-capability-slice.md)
- [ADR-0015：每个能力切片必须独立认证](../adr/0015-certify-each-capability-slice.md)
