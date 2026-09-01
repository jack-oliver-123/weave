## 1. 本地认证模式

- [x] 1.1 让 profile 接受互斥的 `credential` 或 `api_key`，并支持本地明文及完整 `${ENVIRONMENT_VARIABLE}` 引用。
- [x] 1.2 保持 Credential Broker 的引用凭据路径，并将本地 API Key 限制为主机中固定 Provider SDK 的认证材料。
- [x] 1.3 为两种模式使用不含秘密的 Task 认证来源标识，保持 origin 绑定和重定向拒绝。

## 2. 脱敏回归验证

- [x] 2.1 覆盖明文 API Key、环境变量引用、Credential Reference、同时配置和缺失认证字段的配置测试。
- [x] 2.2 验证启动诊断、运行错误、日志和审计不包含 API Key，且 API Key 不进入模型、工具或沙箱。

## 3. 规范同步与验证

- [x] 3.1 将 `multi-protocol-llm` delta 同步到主规范，并核对认证模式、客户端边界和模型目的地条款。
- [x] 3.2 将 `sandbox-execution` delta 同步到主规范，并核对 `CredentialUse` 规则仍只适用于沙箱和受控工具动作。
- [x] 3.3 运行变更与全量 OpenSpec 严格校验，以及配置聚焦测试、类型检查和 lint。
