## ADDED Requirements

### Requirement: Linux 认证必须显式验证 namespace 启动前提

Linux 真实 backend 认证工作流 MUST 在运行完整能力切片前验证当前 Runner 能以普通用户创建 user、mount、PID 与 network namespace。若宿主 AppArmor 限制非特权 user namespace，工作流 SHALL 只为认证使用的固定 `unshare` 可执行文件安装最小 `userns` profile，MUST NOT 全局关闭 AppArmor 限制、使用特权 Worker 或把普通 CI 结果替代为认证通过。

#### Scenario: Ubuntu Runner 限制非特权 user namespace
- **WHEN** Linux 认证运行在启用 AppArmor 非特权 user namespace 限制的临时 Runner 上
- **THEN** 工作流为固定 `unshare` 可执行文件加载最小 profile，随后以普通用户完成 namespace bootstrap 前提检查，再运行完整认证

#### Scenario: namespace bootstrap 前提仍不可用
- **WHEN** 最小 profile 加载后普通用户仍不能创建认证所需 namespace
- **THEN** 工作流在完整认证前失败并明确报告 bootstrap 前提未满足，不生成通过状态或启用任何能力

### Requirement: 认证结果与证据签名配置必须独立报告

Linux 认证工作流 SHALL 分别记录沙箱测试 outcome 与签名配置 outcome。每份上传的认证结果 artifact MUST 使用受信 Ed25519 私钥签名，并绑定确切 commit、OS、backend 版本、probe 版本与逐项 probe 状态；签名密钥缺失时工作流 MUST 明确失败且 MUST NOT 上传未签名 artifact。普通 CI 成功、测试 outcome 缺失或 artifact 缺失 MUST NOT 被解释为平台认证通过。

#### Scenario: 沙箱测试失败但签名密钥可用
- **WHEN** Linux 真实沙箱测试失败且认证签名配置有效
- **THEN** 工作流上传 capabilities 为空、状态为 `failed` 的签名 artifact，并保持认证任务失败

#### Scenario: 认证签名密钥缺失
- **WHEN** `WEAVE_CERTIFICATION_SIGNING_KEY` 未配置或为空
- **THEN** 工作流以独立配置错误失败、不执行未签名证据写入，并且不把沙箱测试 outcome 改写为通过
