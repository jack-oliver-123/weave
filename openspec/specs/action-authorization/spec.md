# action-authorization Specification

## Purpose

定义 Weave 如何把模型和宿主提出的受控操作标准化为完整能力需求，并通过不可绕过的五层决策、结构化人在回路和任务级授权状态生成可执行或可重新规划的确定性结果。

## Requirements

### Requirement: 所有受控操作通过 Task 级 Action Gateway
系统 SHALL 为每个 Task 创建唯一 Action Task Session，并 SHALL 在创建时固定 Policy Snapshot、Permission Mode、Model Destination、Path Capability Boundary、Task Resource Budget 与初始 Authorization Epoch。模型交换、业务工具、Memory 持久化及未来 MCP、hook、plugin 副作用 MUST 通过该 Session；AgentLoop MUST NOT 直接调用模型、工具注册中心、Sandbox Runner 或 Broker。

公开受控请求 SHALL 只包含 `model_exchange` 与 `action_batch` 两类封闭、版本化请求。Task 结束时系统 SHALL 撤销未使用票据与 Task-scoped Grant、终止授权进程树、销毁 Task Sandbox 与私有上下文；已完成副作用 MUST NOT 回滚。

#### Scenario: 创建任务安全上下文
- **WHEN** 上层创建一个启用已认证能力的新 Task
- **THEN** 系统固定该 Task 的策略、模式、模型目标、路径、资源与授权纪元，并在任何模型或工具操作前建立 Action Task Session

#### Scenario: 尝试绕过 Action Gateway
- **WHEN** 运行路径尝试不经 Action Task Session 直接调用模型、业务工具或 Runner
- **THEN** 系统将其视为 Security Integrity Failure，阻止操作并终止当前安全上下文

### Requirement: 以标准化动作和完整能力清单表达提案
每个 Action Proposal SHALL 在授权前映射为一个不可拆分、具有稳定摘要的 Normalized Action，并 SHALL 完整声明不可变 Capability Manifest。首版 Capability Primitive MUST 只包含 `FilesystemRead`、`FilesystemWrite`、`ProcessSpawn`、`NetworkEgress`、`CredentialUse`、`DataDisclose` 与 `MemoryPersist`；未知能力或无法表达最小权限的动作 MUST 被拒绝。

一个提案 MUST NOT 被部分执行或在执行后增加能力。若多个操作能够独立授权，提案方 SHALL 把它们声明为多个 Action Proposal。工具执行获得结果后，系统 SHALL 为向模型、终端、历史、文件或网络释放内容创建独立 Result Disclosure Action。

#### Scenario: 动作完整声明多个能力
- **WHEN** 一个结构化进程需要读取工作区并访问一个网络目标
- **THEN** 系统在执行前形成包含 ProcessSpawn、FilesystemRead 与 NetworkEgress 的单个完整 Manifest，并对任一未获准能力拒绝整个动作

#### Scenario: 动态未知能力
- **WHEN** 扩展提案包含受信 schema 未注册或当前 backend 无法表达的能力
- **THEN** 系统失败关闭且不得把未知字段忽略为较小动作

### Requirement: 按固定五层防线顺序裁决动作
每个 Normalized Action SHALL 依次经过 Command Risk Check、Path Capability Boundary、Permission Rules、Permission Mode 和 Authorization Confirmation。Built-in Hard Denial 或路径边界拒绝 MUST NOT 被后续规则、模式或 HITL 覆盖；显式规则 SHALL 优先于模式，仅 `ask` SHALL 进入 HITL。应用层最终 `allow` SHALL 只允许系统签发 Capability Ticket，动作仍 MUST 在匹配 Manifest 的 OS Sandbox 内执行。

Command Risk Check SHALL 只对安全控制面破坏、Sandbox 逃逸、宿主设备或策略访问、提权、原始 IPC、凭据披露、宿主级灾难、工作区根灾难性删除和资源炸弹产生 Built-in Hard Denial；其他高风险动作 SHALL 产生风险标记或 `ask`。Prompt Injection 检测 SHALL 只能提高风险，MUST NOT 产生 allow 或替代运行时强制。

#### Scenario: 硬拒绝不可被批准
- **WHEN** 动作尝试读取宿主凭据或修改 Sandbox 控制面，即使用户策略和 HITL 表示允许
- **THEN** 系统仍返回不可覆盖的 deny，且不签发 Capability Ticket

#### Scenario: 应用允许仍进入沙箱
- **WHEN** 一个动作通过全部五层并获得最终 allow
- **THEN** 系统只为其签发窄范围票据并要求 Runner 在派生的 OS profile 内执行，不得回退宿主执行

### Requirement: 使用类型化规则和逐能力 Allow Coverage
Permission Rule SHALL 使用版本化、声明式、无代码、无正则、无否定和无顺序语义的类型化 schema。全部匹配规则 SHALL 按 `deny > ask > allow > no_match` 合并。`deny` 或 `ask` 命中动作或任一能力 SHALL 收紧整个动作；`allow` SHALL 只覆盖其明确匹配的单项 Capability Requirement，动作名称 MUST NOT 隐式覆盖其他能力。多条可信 allow 规则 MAY 共同覆盖完整 Manifest，未覆盖能力 SHALL 继续由其他规则或 Permission Mode 裁决。

工作区外、通过所有权、ACL、普通文件身份与内容摘要验证的用户安全策略 SHALL 可以产生 `allow | ask | deny`。工作区内 `.weave-policy.yaml` 及不能证明可信的配置 SHALL 只能产生 `ask | deny`。项目规则、加载顺序和自然语言 MUST NOT 扩大权限。

#### Scenario: 命令 allow 不隐含网络
- **WHEN** 用户规则只允许一个结构化进程的 ProcessSpawn，但该动作还要求 NetworkEgress
- **THEN** ProcessSpawn 获得覆盖而 NetworkEgress 保持 no_match，并继续由其他规则或 Permission Mode 裁决

#### Scenario: 项目尝试授予能力
- **WHEN** 工作区策略声明 allow 文件写入或网络访问
- **THEN** 系统拒绝该配置为无效授权来源，且不得扩大 Task 权限

### Requirement: 以三种 Permission Mode 提供保守默认值
系统 SHALL 支持 `read_only`、`supervised` 与 `autonomous` 三种模式，并 MUST NOT 提供 `full_access`。三种模式 SHALL 默认允许普通 FilesystemRead 以及普通数据向固定模型或本地终端披露。

`read_only` SHALL 默认拒绝 FilesystemWrite、ProcessSpawn、NetworkEgress、CredentialUse 与 MemoryPersist；`supervised` SHALL 对这些能力要求 ask；`autonomous` SHALL 默认允许 FilesystemWrite 与本地结构化 ProcessSpawn，但 SHALL 对 Raw Shell、高风险进程、NetworkEgress、CredentialUse 与 MemoryPersist 要求 ask。Sensitive Data 披露在全部模式中 SHALL 为 ask，Credential Data 披露 SHALL 为 Built-in Hard Denial。

精确可信 allow 规则 MAY 覆盖模式产生的 ask 或 deny，但 MUST NOT 覆盖 Built-in Hard Denial、Path Capability Boundary 或 OS Sandbox。

#### Scenario: autonomous 不能自动联网
- **WHEN** autonomous Task 提出未被可信规则覆盖的本地结构化进程并请求网络目标
- **THEN** 本地 ProcessSpawn 默认为 allow，但 NetworkEgress 为 ask，完整动作进入 HITL

#### Scenario: read_only 拒绝写入
- **WHEN** read_only Task 提出工作区内文件写入且没有更严格拒绝
- **THEN** Permission Mode 产生 deny，系统返回 Denied Result 且不进入 HITL

### Requirement: 对完整批次预检并在同一 Run 内完成 HITL
一个模型响应中的全部业务动作 SHALL 在任一动作开始前完成 Batch Authorization Preflight。系统 SHALL 集中发布全部 ask 项，但 SHALL 要求每项具有明确决定，MUST NOT 提供无范围 allow all。HITL SHALL 在唯一 ActiveRun 的原 `perform()` 流内产生 Authorization Suspension；等待期间 MUST NOT 调用模型或执行工具。

Authorization Confirmation SHALL 绑定 `taskId + runId + requestId + authorizationEpoch + actionDigest`，并 SHALL 恰好覆盖当前 Pending Authorization 的全部待决项。缺失、额外、过期、重复或不匹配的决定 MUST NOT 改变当前等待。挂起期间普通用户输入 SHALL 保持 busy，只有匹配的结构化决定或取消可以解决等待。

#### Scenario: 批次中有多个待确认动作
- **WHEN** 一个批次包含两个 ask 动作和一个默认允许读取
- **THEN** 系统在任何读取或副作用开始前展示两个待决动作并逐项取得决定，然后才按调度顺序处理允许项

#### Scenario: 提交过期授权决定
- **WHEN** TUI 提交的 requestId、epoch 或 actionDigest 与当前 Pending Authorization 不匹配
- **THEN** 系统返回 `STALE_AUTHORIZATION_REQUEST`，保持原等待且不执行任何动作

### Requirement: 将授权范围限制在一次调用或当前 Task
One-time Grant SHALL 只允许绑定当前 callId 与完整动作摘要的单次执行。Task-scoped Grant SHALL 只在当前 taskId 内覆盖由 Gateway 生成并向用户展示的窄范围；模型 MUST NOT 定义或扩大该范围。每个获准调用仍 SHALL 签发独立、短时、单次消费的 Capability Ticket。

任何新的自然语言输入、问题回答或 Plan revision SHALL 推进 Authorization Epoch，撤销旧 Task-scoped Grant 与未消费票据；无文本的恢复操作 MAY 保留纪元。HITL 决定本身 MUST NOT 推进纪元。可信策略的扩权 SHALL 只对新 Task 生效，宿主 deny 或撤销 SHALL 可以立即提高 revocation version、取消在途动作并杀死关联进程树。

用户明确拒绝 SHALL 以标准化动作指纹形成 Task-scoped Denial；同一动作在当前 Task 中再次出现 SHALL 返回 `PREVIOUSLY_DENIED` 而不重复询问，实质目标或参数变化 SHALL 作为新动作重新预检。

#### Scenario: 新用户输入撤销任务授权
- **WHEN** 用户在同一 Task 中提交新的自然语言补充并继续运行
- **THEN** 系统推进 Authorization Epoch，撤销旧 Task grant 与票据，并对后续动作重新预检

#### Scenario: 重复已拒绝动作
- **WHEN** 模型在同一 Task 再次提出与用户明确拒绝指纹相同的动作
- **THEN** 系统不再次打断用户，返回 PREVIOUSLY_DENIED 并允许 AgentLoop 重新规划

### Requirement: 区分可重新规划拒绝与安全完整性故障
策略、模式、路径、敏感披露拒绝、资源超限、Workspace 冲突、Sandbox 能力不足和正常票据过期 SHALL 作为结构化 Denied Result 或普通安全错误返回，计入调用与迭代预算，并 SHALL 允许 AgentLoop 进入下一轮重新规划。

票据伪造、摘要不匹配或重放，Runner 身份或隔离失效，Gateway 绕过，以及审计、策略、凭据或恢复完整性失效 SHALL 是 Security Integrity Failure。系统 SHALL 终止当前 Run、撤销票据、终止进程并销毁 Task Sandbox，MUST NOT 把该故障伪装成普通工具拒绝继续运行。

#### Scenario: 权限拒绝后继续
- **WHEN** 一个写入动作被模式或用户明确拒绝且安全边界仍可信
- **THEN** AgentLoop 收到 isError 的 Denied Result，并可在下一迭代提出只读替代方案或请求不同动作

#### Scenario: 检测到票据重放
- **WHEN** Sandbox Supervisor 收到已经消费的 Capability Ticket nonce
- **THEN** 系统产生 Security Integrity Failure，停止当前 Task 且不启动新的 Action Worker
