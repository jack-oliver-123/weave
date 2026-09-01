## MODIFIED Requirements

### Requirement: 凭据只能由宿主代理按引用使用

沙箱 `CredentialUse` 动作的凭据原文 MUST 仅存在于操作系统凭据存储和宿主 Credential Broker 中；模型、AgentLoop、Runner、Worker、工具参数、工具输出、日志和审计 MUST 仅接触不含秘密的 Credential Reference。Windows MUST 使用 Credential Manager，Linux MUST 使用 Secret Service，WSL2 MUST 使用经鉴别的宿主代理；若安全凭据后端不可用，`CredentialUse` MUST 不可用。本要求不限制主机进程从用户本地模型 profile 读取的 `api_key`，但该值只可作为固定 Provider SDK 的认证材料，MUST NOT 进入沙箱、模型、AgentLoop、工具参数、工具输出、日志或审计。

#### Scenario: 带凭据的网络动作执行
- **WHEN** 已授权动作引用一个凭据并调用网络代理
- **THEN** Credential Broker 仅在宿主代理发送时注入秘密，且秘密不会进入沙箱或返回结果

#### Scenario: 本地模型 profile 使用 API Key
- **WHEN** 主机进程使用本地 profile 的 `api_key` 发起固定 Provider 请求
- **THEN** 密钥只用于该 Provider SDK 的认证，且不会创建沙箱 `CredentialUse` 动作或进入沙箱和审计结果
