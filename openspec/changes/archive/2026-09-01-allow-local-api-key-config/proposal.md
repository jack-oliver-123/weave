## Why

Weave 的本地配置位于用户目录，通常不会进入仓库；强制将 API Key 移入操作系统凭据存储会阻断已有本地 profile 的启动。当前实现已支持 SDK 直接使用 `api_key`，但主规范仍要求拒绝该配置，造成规范与实际行为不一致。

## What Changes

- 允许每个本地模型 profile 使用明文 `api_key` 或 `credential` 引用之一进行认证。
- 保留 `${ENVIRONMENT_VARIABLE}` 作为 `api_key` 的可选来源，不再将其视为弃用迁移路径。
- 保留认证来源互斥校验，并要求 API Key 不得进入诊断、日志、审计、模型上下文、工具参数、工具输出或沙箱。
- 调整 Credential Broker 的规范边界：它继续负责引用凭据与受控工具动作；本地模型 profile 的直接 SDK 认证不再强制经过 Broker。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `multi-protocol-llm`: 修改本地 profile 的认证配置、固定模型目的地和 Provider 认证要求，以支持本地 `api_key`。
- `sandbox-execution`: 收窄凭据只可按引用使用的要求，使其适用于沙箱和受控工具动作，而不限制主机上的本地模型 profile 配置。

## Impact

- 规范：`openspec/specs/multi-protocol-llm` 与 `openspec/specs/sandbox-execution`。
- 运行时：`src/config/index.ts` 解析本地 API Key，并由现有 Provider SDK 认证路径使用；`credential` 引用和 Credential Broker 保持可用。
- 安全边界：审计、历史、模型输入输出和沙箱均继续禁止保存或披露 API Key 原文。
