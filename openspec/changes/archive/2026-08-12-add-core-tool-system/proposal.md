## Why

Weave 当前只能进行纯文本多轮对话，模型无法读取工作区、修改文件、搜索代码或运行验证命令，尚不能形成 Coding Agent 的基本闭环。现在需要在既有三协议和单页 TUI 基础上引入一套边界明确、失败可反馈、跨协议一致的核心工具系统。

## What Changes

- 新增启动时固定且运行期不可变的 `ToolRegistry`，集中管理结构化工具定义、JSON Schema、工具实例和单调用分发。
- 新增通用 `BaseTool<TInput, TData>` 与统一 `ToolCallResult`，以必填布尔字段 `isError` 区分成功和失败，并把可恢复失败作为模型重新规划的输入。
- 新增 `read_file`、`create_file`、`edit_file`、`bash`、`glob`、`grep` 六个核心工具；文件工具受工作区边界、UTF-8、体积、超时和取消约束。
- 新增 `ToolCallScheduler`，将连续只读调用组成并行批次，将写入与 Bash 调用作为有序独占屏障，并在写入失败后标记剩余调用为 `PRIOR_WRITE_FAILED`。
- 将单次模型调用扩展为最多 10 个模型回合的 Agent Loop，保留中间文本、工具调用、工具结果和可恢复错误，直到模型给出不再请求工具的最终文本。
- 扩展 Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses 适配器，使其从同一份中立定义生成工具描述、完整组装流式调用并回传协议对应的工具结果。
- 扩展会话历史为协议无关的内容块，增量保存完整模型响应和工具轨迹；本次仍不实现历史压缩、跨进程持久化或自动重试。
- 扩展 TUI，以单一对话滚动区显示紧凑的工具等待、执行、成功、失败和跳过状态，不增加第二个滚动区域。
- 新增 `tools.enabled`、`--tools`、`--no-tools` 和 `--workspace <path>`；工具默认启用，关闭后保持现有纯文本路径兼容。
- 本次明确不包含权限审批、HITL、沙箱、MCP、动态插件、用户自定义工具、跨调用事务、自动回滚、Diff、Undo 或持久化审计。

## Capabilities

### New Capabilities

- `core-tools`: 定义不可变工具注册中心、通用工具基础实现、六个内置工具、工作区路径与资源边界、结构化定义及统一结果契约。
- `tool-execution`: 定义只读并行与写入独占的批次调度、失败传播、取消、调用数量限制和结果回传预算。

### Modified Capabilities

- `multi-protocol-llm`: 从纯文本请求扩展为三种协议一致的工具定义、流式工具调用组装、工具结果映射和纯文本回退。
- `conversation-management`: 从原子提交纯文本消息对扩展为多模型回合 Agent Loop，以及文本、工具调用和工具结果的增量历史。
- `terminal-chat`: 增加工作区与工具启停启动参数、紧凑工具状态事件和整轮 Agent Loop 统计，同时保持单一滚动区域。

## Impact

- 主要影响 `src/tool/`、`src/engine/`、`src/shared/types.ts`、`src/memory/`、`src/config/`、`src/interaction/` 和应用装配入口。
- 三个 LLM 客户端的请求、流事件和消息转换契约将扩展，但 `tools.enabled: false` 时必须保持现有纯文本行为。
- 需要增加 JSON Schema 运行时校验和跨平台 glob 实现依赖；grep 保持 Node.js 原生遍历与字面量搜索，不依赖系统命令。
- 默认测试将增加工具层、调度、Agent Loop、三协议闭环、TUI 状态和纯文本回归；真实 API smoke 仍为手动可选门槛。
- 工具直接操作本地工作区，且 `bash` 不受权限系统或沙箱限制；这一残余风险必须在设计和用户文档中明确说明。
