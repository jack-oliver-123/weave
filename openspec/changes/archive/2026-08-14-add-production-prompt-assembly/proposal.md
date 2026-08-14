## Why

Weave 当前只按 AgentLoop 阶段拼接数行最小 System Prompt，无法稳定表达终端 Coding Agent 的角色、行为、安全、工具、代码质量和输出契约，也没有区分可缓存的稳定指令与每轮变化的运行上下文。需要建立可审计、可扩展且跨三种 Provider 一致映射的生产级 Prompt 组装管线，在提高任务质量的同时用真实 usage 证据验证缓存效果。

## What Changes

- 新增类型化 Prompt 组装管线，将八个输入来源确定性映射为 `system`、`tools`、`messages` 三个协议无关字段。
- 将静态 System Prompt 拆为身份、系统约束、任务模式、动作执行、工具使用、语气风格、文本输出七个固定模块，并定义显式冲突裁决规则、版本与审计元数据。
- 新增 `SystemReminder` 动态容器，首版承载白名单环境事实与可信运行时状态，并为后续 `WEAVE.md`、自动记忆、已激活 Skill 预留类型化扩展槽；本次不实现这些后续来源的加载或持久化。
- 明确环境自由文本、工具结果、对话内容不得提升为系统指令；动态自由文本必须保持来源、信任等级和确定性转义边界。
- 强化专用工具优先、修改现有文件前读取相关上下文等工具契约，并保持当前阶段最小工具暴露优先于缓存命中率。
- 将 ReAct、Plan 的稳定协议留在静态提示词，把当前模式、阶段、迭代预算、计划与步骤等状态放入每轮动态提醒。
- **BREAKING**：以结构化 Prompt 请求契约替换 `LlmRequest.systemPrompt`，不保留旧字符串入口；Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 同步迁移原生映射。
- 扩展统一 usage，解析 Provider 实际返回的缓存读取与缓存写入指标；缺失指标时保持未知，不推算缓存命中。
- 增加确定性契约测试、Prompt 快照、三协议映射测试、可选 live cache smoke 和人工典型场景清单；本次不实现自动模型质量评分。

## Capabilities

### New Capabilities

- `prompt-assembly`: 定义静态七模块、SystemReminder 动态容器、八个输入来源到三个输出字段的组装、信任边界、版本审计与扩展槽。

### Modified Capabilities

- `agent-task-execution`: 将 AgentLoop 的最小阶段提示改为稳定模式协议与每轮动态运行状态，并约束调查、执行、验证、完成和用户询问行为。
- `multi-protocol-llm`: 将结构化 Prompt、动态系统上下文和最小工具集合映射到三种原生协议，并归一化真实缓存 usage 指标。

## Impact

- 影响 `src/engine/prompt-builder.ts`、`src/engine/agent-loop.ts`、`src/shared/types.ts`、工具描述构建和三个 Provider 适配器。
- 需要迁移依赖 `LlmRequest.systemPrompt` 的单元测试、集成测试、快照、假 Provider 与 live smoke。
- 不新增生产依赖，不实现权限系统、项目指令文件加载、自动记忆、真实 MCP 接入或自动化模型质量评估。
- 当前安全边界仍有明确残余风险：授权要求属于模型软约束，真正的拒绝与审批必须由后续运行时权限系统实现。
