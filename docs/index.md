---
title: Weave WIKI
---

# Weave WIKI

Weave 是支持 Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses 的终端 Coding Agent。

## 核心工具

工具默认启用，并固定提供六个核心工具：

- `read_file`：读取工作区 UTF-8 文本文件或指定行范围。
- `create_file`：创建新文件，不覆盖已有文件。
- `edit_file`：通过唯一精确匹配原子编辑文件。
- `glob`：按 glob 模式查找普通文件。
- `grep`：逐行执行字面量文本搜索。
- `bash`：在工作区内运行非交互 Bash 命令。

所有文件路径和 `bash.cwd` 都必须相对于启动工作区。默认工作区是启动目录，也可以使用 `weave --workspace <path>` 指定。使用 `weave --no-tools` 可关闭工具并恢复纯文本对话路径；配置文件也支持根节点或 profile 的 `tools.enabled`。

本版本不包含权限审批、人工确认、命令 allowlist、进程沙箱或网络限制。`bash` 以当前用户权限运行，可能访问网络或产生工作区外副作用；只应在可信工作区和受控环境中启用。

## 配置

参考仓库根目录的 `config.example.yaml`。工具开关优先级为命令行、当前 profile、配置根节点、默认值 `true`。

OpenAI Chat Completions profile 默认使用连续两个 `system` 消息分别承载稳定指令和动态提醒。仅当兼容端点不支持这种形式时，将该 profile 的 `chat_system_mode` 显式设为 `single`；此时两段内容合并为一个 `system` 消息，不会降级为 user 消息。该字段不适用于其他协议。

- [OpenSpec 变更](/changes/)
