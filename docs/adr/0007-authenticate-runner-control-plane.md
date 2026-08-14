---
status: accepted
---

# Runner 控制面使用身份验证与签名票据

Action Gateway 与 Sandbox Supervisor 只通过不监听 TCP、限制为当前用户的本地 Runner Control Channel 通信，并在启动时完成双向身份确认，将 Supervisor 身份绑定到 Sandbox Capability Report。宿主安全层每次启动生成临时 Ed25519 密钥对，私钥不离开宿主；Capability Ticket 绑定 runner、sandbox、Task、Run、调用、动作与能力摘要、策略和撤销版本、授权纪元、nonce 及有效期，由 Supervisor 使用公钥验证。

Supervisor 不信任宿主提供的执行 profile：它必须重新标准化动作、重新派生 Action Sandbox Profile、核对全部摘要，并在创建 Action Worker 前原子消费 nonce。签名无效、身份或摘要不匹配及 nonce 重放属于 Security Integrity Failure；正常过期或即时收权返回结构化拒绝并要求重新预检。Action Worker 只接收验证后的动作和执行描述，不接收原始票据、密钥、策略或控制通道。任一平台无法提供受限 IPC、对等身份或防重放状态时，工具模式失败关闭。
