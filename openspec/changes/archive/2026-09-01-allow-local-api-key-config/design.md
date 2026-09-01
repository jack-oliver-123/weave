## Context

参见本变更 proposal 的动机。现有 profile 配置解析已区分 `credential` 与 `api_key`，三个 Provider SDK 也能直接接收 API Key；但现行主规范仍将引用凭据视为唯一合法来源。此次变更需要让配置、模型目的地元数据和沙箱规则对两种认证路径使用一致且不泄露秘密的边界。

## Goals / Non-Goals

**Goals:**

- 将本地 profile 认证建模为互斥的 `credential` 引用与 `api_key` 来源两种模式。
- 使明文和 `${ENVIRONMENT_VARIABLE}` API Key 直接用于固定 Provider SDK，同时保留对诊断、审计、模型上下文和沙箱的隔离。
- 保留 Credential Broker 作为引用凭据和沙箱 `CredentialUse` 动作的唯一秘密注入路径。
- 用不含密钥的认证来源标识固定 Task 的模型目的地。

**Non-Goals:**

- 不修改凭据管理 CLI、Windows Credential Manager、Linux Secret Service 或 WSL2 凭据代理。
- 不允许工具、Runner、Worker 或模型读取本地配置中的 API Key。
- 不新增 API Key 的持久化、导出、显示、审计或跨 profile 共享机制。
- 不改变 Provider origin 绑定、重定向拒绝、Input Guard 或 Output Guard 的安全行为。

## Decisions

### 1. Profile 认证字段保持互斥

profile 必须配置 `credential` 或 `api_key` 之一。`credential` 保持为非秘密引用；`api_key` 接受直接字符串或完整 `${ENVIRONMENT_VARIABLE}` 引用，并在配置加载时解析环境变量。

选择互斥而不是优先使用其中一个，避免配置修改或环境差异导致认证来源静默变化。保留仅允许 `credential` 的方案会继续阻断用户目录中的已有本地配置，因此不采用。

### 2. 认证材料只在主机 Provider 边界分流

`credential` profile 继续由 Credential Broker 在受控网络发送边界注入秘密。`api_key` profile 仅在主机进程内配置到当前固定 origin 的 Provider SDK；该值不成为模型请求 body、消息、重试载荷或公开诊断的一部分。

不将本地 API Key 伪装成 Credential Reference，因为这会让 Task 元数据和 Broker 语义不真实。也不将 API Key 写入操作系统凭据存储作为隐式迁移，因为该操作改变用户本地配置的可用性并引入未请求的状态写入。

### 3. 模型目的地记录认证模式而非秘密

Task 创建时固定 profile、protocol、model、规范化 origin 和不含秘密的认证来源标识。引用模式记录 Credential Reference；API Key 模式只记录本地 API Key 认证模式。目标绑定、重定向拒绝和新 Task 要求继续覆盖两种模式。

这避免直接 API Key 进入 Action Gateway、授权记录或审计，同时保留目的地不可漂移的可验证性。

### 4. 沙箱规则只约束沙箱凭据能力

`sandbox-execution` 中的“按引用使用”规则继续完整适用于 `CredentialUse` 动作及其 Worker、网络代理和返回结果。该规则不延伸到主机本地 profile 的 Provider SDK 认证；后者仍被明确禁止进入沙箱。

不删除 Credential Broker 或放宽工具层的凭据要求，以避免把本地模型认证的兼容性需求扩大为通用工具凭据泄露通道。

## Risks / Trade-offs

- [用户目录配置被其他本地进程或备份读取] → 明确将 `api_key` 定义为用户可选择的本地模式；继续提供 `credential` 作为更强隔离路径，并禁止应用日志、审计和模型路径记录该值。
- [直连 SDK 路径绕过 Broker 的 origin 约束] → 认证模式仍绑定到固定 profile 和规范化 origin；SDK 请求继续拒绝重定向和运行中目标切换。
- [API Key 误入错误对象或测试快照] → 配置、协议适配器和测试保持脱敏断言；任何诊断与审计只使用不含秘密的认证来源标识。
- [未来将本地模式误用于工具凭据] → delta spec 明确 `CredentialUse`、Runner 和 Worker 仍只接受 Credential Reference。

## Migration Plan

1. 同步 `multi-protocol-llm` 和 `sandbox-execution` 主规范，声明两种认证模式及其边界。
2. 保留已存在的本地 `api_key` 配置，不要求用户迁移或写入系统凭据存储。
3. 验证明文、环境变量和引用凭据三种配置，以及同时配置和缺失认证字段的失败路径；验证诊断、日志和审计不包含 API Key。
4. 若需要回滚，恢复主规范的引用凭据唯一模式，并恢复配置解析对明文 API Key 的拒绝；用户现有本地配置文件不由应用自动改写。
