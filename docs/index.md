---
title: Weave WIKI
---

# Weave WIKI

Weave 是支持 Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses 的终端 Coding Agent。所有模型交换与工具动作都经过 Task 级 Action Gateway。

## 工具与权限

工具按运行时认证结果发布，不保证每个平台都出现完整集合：

- `read_file`、`glob`、`grep`：读取经授权的工作区内容。
- `create_file`、`edit_file`：在 Task 私有 CoW 中变更，再由事务提交代理写入宿主。
- `bash`：在无原始网络、清空环境的 Action Worker 中执行。
- `remember`：经 `MemoryPersist` 授权后保存净化的项目或用户记忆。

权限模式为 `read_only`、`supervised` 和 `autonomous`。它们只提供默认裁决；hard deny、路径边界、项目收紧策略和 OS 认证结果始终优先。需要确认的动作在同一对话转录区展示，可选择单次允许、Task 内允许、拒绝或取消。

使用 `weave --no-tools` 可显式进入纯文本模式。沙箱缺失、探针未知或认证失败时不会回退到宿主工具执行。

## 凭据

profile 使用凭据引用，不保存明文：

```yaml
profiles:
  - name: claude
    protocol: anthropic-messages
    model: claude-model-name
    base_url: https://api.anthropic.com
    credential: provider:anthropic
    thinking: false
```

管理命令：

```text
weave credential set provider:anthropic
weave credential list
weave credential delete provider:anthropic
```

`set` 在终端隐藏输入，也接受 stdin；`list` 只显示引用与更新时间。`${ENV}` 仅作为本 major 的弃用迁移入口，启动时会警告。明文 `api_key` 被拒绝。

## 平台状态

Linux 与 WSL2 使用独立 namespace 认证；WSL2 还验证 Windows 盘、interop 与 Windows PATH 不可见。Windows Sandbox 仅接受 Windows 11 24H2+ 新版 `wsb.exe`，并且只有单项纵切片真实认证后才发布对应能力。`failed`、`not_run`、`skipped`、`unknown` 和 `flaky` 都不发布能力。

审计保存在工作区外，只记录摘要、裁决、票据与结果状态，默认保留 30 天或 100 MiB。事务恢复无法安全判定时进入 `RECOVERY_CONFLICT`，写能力保持关闭，用户确认只清理恢复元数据，不覆盖外部编辑。

详细说明见 [运行时安全指南](/security/runtime-guide)、[本地认证状态](/security/certification-status) 和 [Agent 权限与沙箱架构](/security/agent-permission-system)。

- [OpenSpec 变更](/changes/)
