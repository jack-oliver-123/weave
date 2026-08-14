## Context

动机见同一变更目录的 `proposal.md`。当前运行链在 `main.ts` 组装 Provider、六个宿主工具、调度器和 ConversationManager；AgentLoop 直接持有模型客户端与 ToolExecutor，ToolExecutor 经 Scheduler/Registry 调用 BaseTool。文件工具依赖工作区路径校验，`bash` 则在宿主用户权限下启动 shell、继承大部分环境并拥有原始文件、进程和网络访问。现有 `SecurityLayer` 与 `PermissionRequest` 只有未接入的类型壳，计划审批和 `request_user_input` 也不是运行时授权边界。

这使权限判断不能只插在 ToolRegistry 前：模型请求本身可能泄露数据，工具原始结果也可能未经授权进入模型或终端，而宿主内 `bash` 可以绕过所有应用层路径判断。设计需要同时切断模型、工具、数据和 OS 执行四条旁路。

本变更跨越 `src/engine`、`src/security`、`src/tool`、`src/memory`、`src/llm`、`src/config`、`src/interaction` 和独立 Runner。详细安全契约见本变更的 12 份 delta spec；稳定领域术语与信任边界见 `CONTEXT.md`，完整参考架构见 `docs/security/agent-permission-system.md`，决策记录见 `docs/adr/0001-*.md` 至 `docs/adr/0015-*.md`。

约束如下：

- Weave 首版仍是本地单用户进程，没有登录主体、租户或 RBAC。
- 活动 Task 不跨进程恢复；权限、Ledger、Grant 和 Sandbox 都以 Task 为生命周期。
- Linux/WSL2 与 Windows 使用不同 OS 原语，不能用同一个低层实现假装等价。
- 无法证明隔离有效时必须减少能力或纯文本运行，不能兼容性回退到宿主执行。
- TUI 保持单页，授权交互不得增加第二滚动区域。

## Goals / Non-Goals

**Goals:**

- 建立一个足够深的 Action Gateway seam，使 AgentLoop 只能表达“模型交换”和“执行此模型提案批次”，不再拥有模型、工具、数据或 Runner 的绕过句柄。
- 把五层授权、HITL、数据出口、审计、票据和 OS 隔离串成一个 fail-closed 状态机，而不是相互独立的装饰器。
- 让普通拒绝成为模型可消费的结构化结果，同时把安全完整性失效提升为 Task 终止。
- 按能力纵切片交付，每一切片都能从 AgentLoop 到真实 OS 边界独立验证，并在未认证平台上保持不可达。
- 用 expand-contract 迁移消除旧的直连 Provider、宿主工具和明文密钥路径，且迁移期间不形成双写或隐藏 fallback。

**Non-Goals:**

- 不把项目演进为多用户身份、团队角色、资源所有权或租户隔离系统。
- 不承诺抵抗已失陷的宿主 kernel、管理员/root、Weave 安装目录、签名密钥进程或 sandbox kernel escape。
- 不为网络外部副作用提供事务回滚，也不恢复跨进程 Task。
- 不提供 `full_access`、`--unsafe`、永久授权、session-wide allow、任意插件代码策略或项目级 allow。
- 不在一个版本内同时承诺 Linux、WSL2、Windows 和 macOS 的完整工具能力；每个平台独立认证、独立启用。

## Decisions

### 1. 用 Task-scoped Action Gateway 作为唯一安全入口

新增深模块 `ActionGateway`，上层只在 Task 创建时打开一次 `ActionTask`：

```ts
interface ActionGateway {
  openTask(input: OpenActionTaskInput): Promise<ActionTask>;
}

interface ActionTask {
  capabilities(): CapabilityReport;
  perform(
    request: ModelExchangeRequest | ActionBatchRequest,
    signal: AbortSignal,
  ): AsyncIterable<GatewayEvent>;
  resolveAuthorization(input: ResolveAuthorizationInput): Promise<void>;
  close(reason: TaskCloseReason): Promise<void>;
}
```

`ModelExchangeRequest` 只引用 Ledger 中的当前任务状态和交换目的；`ActionBatchRequest` 只携带 Gateway 先前返回的一次性 `ProposalBatchRef`。AgentLoop 不再能提交原始 `ChatMessage[]`、tool name/args 或 Sandbox profile。Gateway 内部组合 Context Custodian、Policy Engine、HITL Coordinator、Audit Sink、Provider Adapter、Ticket Issuer 和 Runner Client。

选择 Task scope 是因为策略快照、模型目的地、路径根、资源预算、授权 epoch、拒绝缓存与 Sandbox 生命周期都需要同一个稳定边界。若把权限做成全局单例，会产生跨 Task grant 泄漏；若只包裹 ToolExecutor，则模型披露、原始 tool call 和结果披露仍可绕过。

替代方案是给现有 LlmClient、ToolExecutor、MemoryStore 分别加 middleware。该方案分散强制点，难以证明所有路径都经过相同策略和审计，因此不采用。对应 ADR 0001、0010。

### 2. 让 Gateway 保管模型提案和原始结果

Provider 原生流先进入 Gateway。文本 delta 经过 Output Guard 才形成可发布事件；tool call delta 在 Gateway 内组装、校验并形成 `NormalizedAction`。AgentLoop 只看到安全描述和一次性 `ProposalBatchRef`，不能复制、改写或重放原始参数。工具原始结果先进入 Secure Context Ledger，再以独立 `DataDisclose` 动作释放给模型、终端、历史、文件或网络。

引用绑定 `taskId/runId/iteration/modelExchangeId/authorizationEpoch/proposalDigest`，短时有效且只消费一次。这样授权摘要、执行参数和 Provider 原始提案由同一可信组件生成，避免“检查 A、执行 B”。

替代方案是把 tool call 继续交给 AgentLoop，再在 Scheduler 中重新解析。该方案扩大可信计算基，并允许中间层重建参数，不采用。对应 ADR 0010。

### 3. 用封闭能力词汇和确定性规范化器驱动五层决策

首版仅接受七类能力：`FilesystemRead`、`FilesystemWrite`、`ProcessSpawn`、`NetworkEgress`、`CredentialUse`、`DataDisclose`、`MemoryPersist`。每个工具注册时提供版本化 Normalizer，由它把原始提案映射为一个不可拆分动作和完整 Manifest。注册验证检查工具实现声明、Schema、Normalizer 和 Runner adapter 一致；未知字段或无法表达的能力拒绝注册或拒绝动作。

决策管线固定为：

```text
proposal
  -> normalize + manifest
  -> command risk check
  -> path capability boundary
  -> permission rules
  -> permission mode
  -> authorization confirmation
  -> durable preflight audit
  -> signed capability ticket
  -> sandbox runner
  -> durable outcome audit
  -> result disclosure action
```

Command Risk 和 Path Boundary 可产生不可覆盖 hard deny；规则采用无代码、无正则、无否定、无顺序语义的类型化结构，合并优先级固定为 `deny > ask > allow > no_match`；allow 逐项覆盖 Manifest，不能因“允许 bash”顺带获得网络或凭据。模式只处理规则未覆盖的能力。HITL 只解决 ask，不能覆盖 hard deny。

替代方案包括 shell 关键词黑名单、通用 regex 规则、按工具名 allowlist 和首条命中。它们分别容易绕过、难以审计、授权过宽或依赖配置顺序，均不作为安全语义。黑名单只保留为第一层的稳定安全不变量与风险标记。对应 ADR 0002、0003、0004。

### 4. 把 HITL 建模为同一 ActiveRun 的挂起状态

Gateway 对完整模型动作批次先做预检。任何动作开始前，所有 ask 项被一次发布；用户必须逐项选择 `allow_once | allow_for_task | deny`，或取消整个请求。`resolveAuthorization` 必须完整绑定 Task、Run、request、epoch 和 action digest，缺项、增项、重复或过期决定不改变等待状态。

Gateway 在原 `perform()` 流内保留 Pending Authorization 和 `ProposalBatchRef`。TUI 提交决定后恢复同一 Promise/AsyncIterable，不创建新 Run、不调用模型，也不把授权文本写入上下文。等待期间只有 resolve 或 cancel 可进入，普通输入返回 busy。计划审批保持独立状态，永不产生动作 grant。

授权状态包含：

- One-time grant：绑定当前 call 与完整动作摘要。
- Task-scoped grant：绑定 Gateway 展示的窄范围，仅当前 Task 有效。
- Task-scoped denial：绑定规范化动作指纹，重复动作直接返回 `PREVIOUSLY_DENIED`。
- Authorization epoch：任何新自然语言、问题回答或计划修订递增，撤销旧 grant 与票据；纯恢复和 HITL 决定不递增。

替代方案是把 HITL 当成 `request_user_input` 并创建新 Run。该方案会丢失精确批次身份、允许模型在决定前后改变参数，并把自然语言误作授权，不采用。对应 ADR 0005。

### 5. 分离 Secure Context Ledger 与 Public Transcript

每个 Task 的 Context Custodian 持有私有 Ledger，内容使用不可变 `ProvenanceEnvelope` 引用：来源、分类、摘要、purpose、允许目的地和派生关系。Public Transcript 只记录已通过 Output Guard 向终端发布的净化内容；ConversationStore 退化为 UI/跨 Task 公开历史，不再直接供模型拼接。

分类格为 `ordinary < sensitive < credential`。透明变换保留分类；模型、shell、任意进程和未知工具等不透明变换继承所有可读输入的最高分类。可信适配器只可对 contentless 的 exit code、count、boolean 等声明普通结果。项目规则和检测器只能升高分类。

Prompt 组装的信任映射固定为：固定 Weave 协议进入 system；中立工具定义进入 tools；用户、项目、Plan、历史、Memory、路径和动态状态作为 untrusted user message；工具结果作为 untrusted tool message；权限规则、决定、票据、审计和凭据不进入模型。Provider 编码结束后执行最终字节扫描，避免适配器或 header 注入绕过 Input Guard。

替代方案是继续把 SystemReminder 当作“可信动态容器”并依赖标签转义。标签只帮助模型理解，不能阻止 Prompt 注入改变模型行为，也不能作为数据出口控制，因此不采用。对应 ADR 0009、0011、0012。

### 6. 把 OS 沙箱拆成 Supervisor、Task Sandbox 和 Action Worker

Runner 是独立进程/组件，可信 Supervisor 管理持久 Task Sandbox；每个动作创建新的低权限 Action Worker。Task Sandbox 只保留 CoW 工作区、资源账本和显式 Task-lifetime 进程；Worker 获得当前动作最小挂载、命名空间、环境和 broker 端点，动作结束即销毁。Worker 看不到策略、审计、Credential Store、签名私钥、控制 IPC 或票据。

宿主与 Runner 使用仅当前 OS 用户可访问的本地 IPC，不监听 TCP，并双向验证身份。Gateway 每次宿主进程启动生成临时 Ed25519 key；Runner 只持有公钥。票据绑定 runner/sandbox/task/run/call、动作与能力摘要、policy/revocation version、epoch、nonce 和时间窗。Runner 重新规范化动作、重新派生 profile，并在启动 Worker 前原子消费 nonce。Worker 不接触票据。

每动作 Worker 比持久 shell 更易证明最小权限、取消和清理；Task Sandbox 保留 CoW 与显式长进程，避免每个动作重建整个 VM 的不可接受成本。替代方案是仅使用 Node Permission Model、Job Object 或应用层路径检查；这些不能同时限制文件、网络、设备和子进程，因此不采用。对应 ADR 0006、0007。

### 7. 按平台实现后端，不抽象掉安全差异

Runner 暴露统一的 `SandboxBackend` 控制契约，但 Capability Report 和认证证据按 backend/version 分离：

- Linux/WSL2：bubblewrap 或等价 user/mount/PID/network namespaces；只读运行时和 CoW 工作区显式挂载；清空环境；默认无网络。WSL2 额外隐藏 `/mnt/c`、interop socket 和 Windows PATH，WSL1 不支持。
- Windows 11 24H2+：Windows Sandbox CLI 管理 Task VM，VM 内使用低权限 Action Worker 与 Job Object 约束资源和进程树；workspace 通过受控映射与 Commit Broker 交互。
- 其他 Windows/macOS：首版没有认证后端时只提供纯文本或已独立认证的更小能力集。

能力探测不是版本字符串判断。Runner 必须主动运行负向探针，证明宿主路径、原始网络、环境、设备、提权、IPC、broker、资源逃逸和进程树都不可达。缺失、未知、超时或“逃逸成功”都使该后端未认证。

替代方案是用最小公分母包装所有平台。它会掩盖 WSL interop、Windows VM 和 Linux namespace 的不同逃逸面，造成错误安全声明，不采用。

### 8. 用 CoW + Commit Broker 提交工作区事务

Task Sandbox 只看到宿主工作区只读基线和 Task 私有 CoW 层。动作完成后 Runner 返回完整 change set；宿主 Commit Broker 校验票据、授权路径、基线文件身份/摘要和 post-image，再在工作区锁下提交。

多文件动作采用持久状态机 `PREPARED -> APPLYING -> COMMITTED -> CLEANED`。Broker 在工作区外、仅当前用户可访问且沙箱不可见的位置创建同卷 staging、backups 与 journal；逐路径使用原子 rename。任一替换失败则回滚全部已替换路径。崩溃恢复时，COMMITTED 之后只清理，否则尝试回滚；若外部编辑使 pre/post identity 都不匹配，则进入 `RECOVERY_CONFLICT`，停止写工具并要求用户显式恢复。

这不是宣称文件系统提供真正的多文件原子提交：外部编辑器可能短暂看到中间状态；保证范围是其他 Weave 动作不会并发观察部分状态，且崩溃后有确定恢复协议。网络和其他外部副作用不纳入该事务。

替代方案是让 Worker 直接写宿主路径，或仅在每个文件使用临时替换。前者失去提交前授权和回滚边界，后者不能恢复跨文件崩溃，不采用。对应 ADR 0008。

### 9. 网络与凭据使用宿主 Broker

Action Worker 默认不能创建原始网络 socket。受控网络请求通过宿主 Egress Broker，按实际 scheme/host/port、DNS 结果和 TLS 校验。重定向是新目标、新动作；loopback、私网、VPN、链路本地、保留地址、元数据和本地 socket 默认拒绝，其中宿主控制面与元数据端点 hard deny。

Provider 和工具凭据仅以 Credential Reference 表达。Credential Broker 在最终发送边界从 Windows Credential Manager、Linux Secret Service 或 WSL2 宿主代理取得秘密并注入；模型、Gateway 通用事件、Runner、Worker、日志和审计不持有原文。Provider Task 还固定 protocol/model/origin，禁止 redirect、fallback 和运行中切换继承原授权。

替代方案是把代理环境变量或 API key 挂载进 Worker。任何子进程和 Prompt 注入都可能读取并外传，且无法限定代用目标，因此不采用。

### 10. 策略加载采用可信扩权、项目只收紧

`~/.weave/security.yaml` 是用户安全策略，加载时验证 owner、ACL、普通文件身份，并拒绝 symlink/reparse/device/network source；只有该层可以声明 allow。`<workspace>/.weave-policy.yaml` 作为不可信项目内容，只接受 ask/deny 和更小资源上限。策略在 Task 创建时形成不可变 snapshot；可信扩权只影响新 Task，可信 deny/revoke 可立即提高 revocation version 并终止在途能力。

模型 profile 迁为 Credential Reference。明文 `api_key` 立即拒绝；`${ENV}` 只保留一个 major 的宿主迁移通道并发出弃用提示。不能把 env 变量原文复制进普通 config 或 Runner。

替代方案是按“后加载覆盖前加载”合并项目与用户策略。工作区内容可被 Prompt 注入或恶意仓库控制，允许其扩权会直接形成供应链越权，不采用。

### 11. 审计是执行和披露的耐久屏障

Audit Sink 位于工作区外，只记录 ID、摘要、风险、分类、规则、模式、决定、ticket/sandbox 元数据和 outcome，不记录 prompt、路径原文、命令、文件内容、stdout/stderr 或秘密。预检与 HITL 决定必须在签票前 durable；Supervisor 最小记录必须在消费 nonce/启动 Worker 前 durable；outcome 必须在结果披露前 durable。

执行前审计失败意味着零执行并触发安全完整性终止。动作可能已产生效果后 outcome audit 失败，系统终止 Task、撤销能力并向用户报告“效果可能已发生”，但不把未审计结果交给模型。普通只读批次可以共用 flush，但保留逐动作记录。工作区事务 journal 与安全审计分离，前者用于恢复，后者用于追责。

替代方案是异步 best-effort 日志。崩溃窗口会留下无授权记录的效果或无结果记录的数据释放，不能满足追责与 fail-closed 要求，不采用。对应 ADR 0013。

### 12. 错误模型分为 Denied Result 与 Security Integrity Failure

可预期的策略拒绝、用户拒绝、路径越界、能力不足、资源超限、正常过期、事务冲突和普通工具错误转换为有界 `isError` 结果。AgentLoop 把它们计入原有调用/迭代预算并继续 ReAct；拒绝不是隐式重试，也不是停止条件。

签名/摘要/身份失败、重放、Gateway 绕过、沙箱认证丢失、执行前审计失败、凭据边界破坏和无法安全恢复的内部不变量属于 Security Integrity Failure。ActionTask 关闭、票据撤销、进程树终止、Sandbox 销毁；错误不进入模型作为“换个参数再试”的观察。

单一泛化错误类型会让 AgentLoop 尝试绕过真实安全故障，或让普通用户拒绝不必要地摧毁任务，因此不采用。

### 13. 以 Capability Slice 纵向迁移和认证

交付单元不是“先把所有接口建完，再一起接通”，而是每个切片从 AgentLoop 到真实边界可运行、可拒绝、可审计：

1. 安全内核 + 纯文本 ModelExchange，无业务工具。
2. 只读文件工具 + Input/Output Guard + Linux/WSL2 backend。
3. CoW 写入 + Commit Broker + 崩溃恢复。
4. 结构化进程，再单独启用 raw shell 和 Task-lifetime 进程。
5. Network Egress、CredentialUse、MemoryPersist。
6. Windows backend 对相同切片逐项认证。

每一切片用 expand-contract：先引入新接口和测试；让旧调用方改走 Gateway；证明旧路径不可达；最后删除旧接口。未认证能力不出现在工具定义中，运行时仍做二次强制检查。普通 CI 只证明确定性内核和 fake E2E；真实 OS 认证证据绑定 commit、OS、backend 与 probe 版本。`skipped/not_run/unknown/flaky` 不等于通过。

替代方案是保留宿主执行作为开发 fallback。fallback 最终会被用户或测试路径依赖，令“安全模式”无法证明完整，故明确不提供。对应 ADR 0014、0015。

## Risks / Trade-offs

- **[范围很大，容易出现长时间不可用的半成品]** -> 按 Capability Slice 纵向交付；首个切片先保持纯文本可用，未认证工具不暴露。
- **[Gateway 可能成为复杂巨型类]** -> 对外保持单一深接口，对内按 Context、Policy、HITL、Audit、Ticket、Runner、Broker 组件拆分；组件间只传封闭领域类型和引用。
- **[错误分类错误会把普通故障升级或把完整性故障降级]** -> 建立显式 error taxonomy、契约测试与故障注入；默认未知安全状态按完整性故障处理。
- **[数据分类过度传播会频繁打断用户]** -> 允许少量登记的 contentless trusted adapters；保留明确来源和 purpose，后续只能通过新规格增加降级器。
- **[数据分类漏标导致外泄]** -> 不透明变换默认继承最高分类，最终字节级 Guard 二次检查，Credential Data 永不允许披露。
- **[多文件事务无法对外部编辑器真正原子]** -> 文档明确可见性边界；工作区锁只协调 Weave，baseline recheck 和 `RECOVERY_CONFLICT` 防止覆盖用户并发修改。
- **[Windows Sandbox VM 启动和文件映射延迟较高]** -> Task VM 持久化、Action Worker 轻量化；不因此降低为裸 Job Object 或宿主进程。
- **[bubblewrap 或 Windows Sandbox 在用户机器不可用]** -> Capability Probe 后 fail closed，并提供纯文本模式；不自动安装、提权或切换 backend。
- **[网络 Broker 仍可能遇到 DNS rebinding、代理和重定向复杂性]** -> 基于实际连接地址校验、重定向重新授权、固定 TLS/目标；首版不做通用代理协议。
- **[审计 durable flush 增加延迟]** -> ordinary 只读批次合并 flush；副作用和敏感披露不降低耐久顺序。
- **[OS Credential Store 跨平台行为不一致]** -> 每个平台 adapter 独立契约与 E2E；后端不可用时 CredentialUse 不可用，不回退 env 注入。
- **[权限请求疲劳]** -> 模式提供保守默认、Task-scoped 窄授权和精确拒绝记忆；仍不提供 allow-all 或永久授权。
- **[项目规则与旧配置迁移造成启动失败]** -> 提供字段级诊断、只读迁移检查和 Credential CLI；明文 key 不自动写入任何新位置。

## Migration Plan

1. **建立不可变安全领域类型和测试夹具**：加入 NormalizedAction、Manifest、PolicyDecision、ProvenanceEnvelope、Gateway request/event、ticket 和 error taxonomy；先用 fake Provider/Runner 验证状态机，不改变生产路径。
2. **接入纯文本 Gateway**：ConversationManager 创建 ActionTask，AgentLoop 改收 ActionTask；Provider 交换、Ledger、Prompt trust mapping 和 Input/Output Guard 先在 `--no-tools` 路径闭环。切换后删除 AgentLoop 直收 `LlmClient` 和 `ChatMessage[]` 的构造入口。
3. **接入规则、模式、HITL 与审计**：实现批次预检和 TUI 同 Run 挂起；此阶段 fake Runner 证明零提前执行、拒绝继续和完整性终止。
4. **引入 Runner 控制面和只读切片**：实现 IPC、身份、Ed25519 ticket、nonce、资源控制、Linux/WSL2 backend 与负向探针；迁移 `read_file/glob/grep`。只有真实 backend 认证通过才从旧路径切换，随后删除三个工具的宿主执行入口。
5. **引入 CoW 和写入事务切片**：实现 Commit Broker、journal、rollback、startup recovery 与 conflict UI；迁移 `create_file/edit_file`，证明所有宿主写入只来自 Broker 后删除直接写路径。
6. **引入进程切片**：先结构化进程，再 raw `bash`，再 Task-lifetime 进程；清空环境、默认无网络、终止进程树。旧 `spawn('bash')` 路径必须在启用前删除而不是保留 fallback。
7. **引入网络、凭据和记忆切片**：实现 Egress/Credential Broker、OS store CLI、固定模型 origin 和 MemoryPersist；迁移 profile 到 `credential` 引用，保留 `${ENV}` 一 major 警告通道，拒绝明文 key。
8. **认证 Windows backend**：在 Windows 11 24H2+ 完成 Task VM 和 Action Worker 切片认证；未通过的能力继续隐藏。macOS 保持纯文本，直到另立变更提供后端。
9. **收缩并删除旧路径**：用静态依赖测试和运行时断言证明 AgentLoop、ConversationStore、ToolRegistry、core tools 与 Provider adapter 不存在旁路；移除 deprecated ToolExecutor host path、SystemReminder 动态提权和下一 major 的 `${ENV}` 入口。
10. **发布与回滚**：每个切片有独立 feature/capability gate，但 gate 只能在认证通过后由发布配置启用。回滚只能关闭未稳定切片并退回更小的已认证能力或纯文本版本；不得回滚到宿主执行、明文凭据或 unsafe 模式。若事务恢复发现冲突，保持工具关闭并由用户显式恢复，不自动覆盖工作区。
