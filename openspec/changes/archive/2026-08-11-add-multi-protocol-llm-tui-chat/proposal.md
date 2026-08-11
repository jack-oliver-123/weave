## Why

Weave 当前只有五层代码骨架，尚不能连接真实大模型，也没有可供用户持续对话的交互入口。现在需要先打通最小可用的纯文本对话链路，用统一边界同时承载 Anthropic 与 OpenAI 的流式协议，为后续工具调用、记忆和安全能力奠定稳定基础。

## What Changes

- 增加本地 YAML 模型配置，支持通过 profile 选择 Anthropic Messages、OpenAI Chat Completions 或 OpenAI Responses 协议，并允许自定义 API 根地址、模型、密钥、thinking 开关占位和输出 token 上限；`thinking: false` SHALL 显式请求非思考模式，`thinking: true` 仍不实现。
- 增加协议无关的 `LLMClient` 封装及三个官方 TypeScript SDK 适配器，把原生流事件、完成原因、usage 和错误归一为稳定契约。
- 增加 `ConversationManager` 与进程内消息存储，支持串行多轮对话、唯一 turn 标识、流式取消、超时和严格的历史提交规则。
- 增加基于 Ink 7 的全屏终端界面，采用小狗品牌标识、单一可滚动对话区、固定输入框和状态栏，并提供明确的按键、滚动、尺寸和安全渲染行为。
- 增加分层自动化测试、Windows `psmux` 与 WSL `tmux` 终端 E2E，以及三种协议的显式真实 API smoke 验收。
- 首版明确不实现工具调用、system prompt、thinking/reasoning 内容输出或思考强度、跨进程持久化、上下文裁剪或摘要、Markdown 渲染、模型热切换、配置向导和斜杠命令。

## Capabilities

### New Capabilities

- `multi-protocol-llm`: 定义 YAML profile、三种 LLM 协议适配、统一流式生命周期、完成信息与安全错误边界。
- `conversation-management`: 定义进程内多轮消息、turn 串行化、取消与超时、历史提交和异常轮次隔离。
- `terminal-chat`: 定义全屏 TUI 布局、输入与滚动交互、状态展示、终端安全和跨平台终端验收。

### Modified Capabilities

无。

## Impact

- 主要影响 `src/shared/`、`src/engine/`、`src/memory/` 与 `src/interaction/`，工具层和安全层不新增业务能力。
- `package.json` 将增加 OpenAI SDK、Ink 7、React、YAML 解析与终端文本处理相关依赖，并把运行时基线明确为 Node.js 22 及以上。
- `src/shared/types.ts` 的流式事件契约会从骨架占位扩展为可表达 turn 生命周期、usage、完成原因和安全错误的协议无关类型。
- 用户级配置默认位于 `~/.weave/config.yaml`；仓库只提供不含真实密钥的示例配置。
- 默认测试不访问真实 API；live smoke 必须显式执行并使用用户本地配置。
