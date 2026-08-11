## 1. 项目依赖与共享契约

- [x] 1.1 更新 `package.json` 的 Node.js 22+ 引擎约束、启动入口、构建与分层测试脚本，并加入 OpenAI SDK、Ink 7、React、YAML 解析和终端文本清理所需依赖
- [x] 1.2 先为 profile、协议请求、LLM 流事件、turn 生命周期、usage、完成原因、安全错误和会话存储端口补充类型级测试
- [x] 1.3 扩展 `src/shared/` 的纯类型契约并建立根级 composition root 接口，确认共享模块不依赖任何具体层或供应商 SDK
- [x] 1.4 建立脚本化假流客户端和测试 fixture，确保默认测试不读取用户配置、不访问网络且不包含真实密钥

## 2. YAML 配置与启动校验

- [x] 2.1 先编写配置验收测试，覆盖默认路径、`--config`、`--profile`、名称唯一性、默认 profile 引用、协议枚举、字段类型和未知 profile
- [x] 2.2 先编写 `max_tokens` 缺省 4096、正整数校验、`thinking: true` 明确失败、明文密钥与环境变量引用解析测试
- [x] 2.3 实现 YAML 配置加载、内部只读映射和字段级中文诊断，并保证所有失败路径对 API Key 脱敏
- [x] 2.4 增加 Node.js 22+ 启动前检查以及 `--help`、`--version` 参数处理，确保失败发生在进入 alternate screen 之前
- [x] 2.5 提交覆盖三种 protocol 且不含真实密钥的 `config.example.yaml`，并确保真实用户配置不会被测试或版本控制意外读取

## 3. 多协议 LLM 客户端

- [x] 3.1 先为 Anthropic 正常文本时序、多个内容块、`ping`、未知无状态事件、乱序、索引不匹配、非文本块和未正常结束编写适配器测试
- [x] 3.2 使用官方 Anthropic TypeScript SDK 实现 Messages 流适配器和严格状态机，映射文本、完成原因与真实 usage
- [x] 3.3 先为 OpenAI Chat Completions 的文本 delta、空 delta、完成原因、截断、拒答、usage 和异常断流编写适配器测试
- [x] 3.4 使用官方 OpenAI TypeScript SDK 实现 Chat Completions 流适配器，并把 `max_tokens` 映射为该协议的输出限制字段
- [x] 3.5 先为 OpenAI Responses 的创建、文本增量、完成、错误、非文本输出、usage 和缺少终态编写适配器测试
- [x] 3.6 使用官方 OpenAI TypeScript SDK 实现 Responses 流适配器，发送完整本地历史且不使用 `previous_response_id`
- [x] 3.7 先编写首事件 120 秒、流静默 120 秒、事件重置计时器、用户取消、终态资源释放和迟到 SDK 事件测试
- [x] 3.8 实现客户端工厂、AbortSignal 与静默计时器组合、统一安全错误映射，并关闭 SDK 隐式自动重试
- [x] 3.9 增加协议边界测试，证明引擎可见类型中没有 Anthropic/OpenAI SDK 类型、原生事件名、鉴权头或未经筛选的响应体
- [x] 3.10 先为 Anthropic 原生禁用字段、DeepSeek OpenAI 兼容扩展和标准 OpenAI 请求不携带供应商扩展编写请求边界测试
- [x] 3.11 实现 `thinking: false` 请求映射，保证 DeepSeek 三协议只产生纯文本流且不改变标准 OpenAI 请求

## 4. 进程内对话管理

- [x] 4.1 先为进程内 user/assistant 消息对、完整历史读取、进程重启空历史和存储替换端口编写记忆层测试
- [x] 4.2 实现只保存清理后已提交消息对的 `InMemoryConversationStore`，不提供截断、摘要或持久化副作用
- [x] 4.3 先为唯一 `turn_id`、串行提交、完整生命周期、并发拒绝、取消与迟到事件隔离编写引擎层测试
- [x] 4.4 先编写历史提交矩阵测试，覆盖正常完成、`max_tokens` 截断、有文本拒答、无文本拒答、取消、超时、网络错误和协议错误
- [x] 4.5 实现 `ConversationManager`，原子提交有效消息对，并在失败时返回原始用户文本供交互层恢复
- [x] 4.6 先编写可重试错误不自动重试和上下文超限不修改本地历史的集成测试，再接通统一客户端与存储端口

## 5. 终端文本安全与状态模型

- [x] 5.1 先编写 ANSI、OSC、光标控制、C0/C1 字符、中文、普通 Unicode、换行、制表符和代码围栏的清理测试
- [x] 5.2 实现共享文本清理器，并保证用户输入、可见模型文本和模型历史使用同一份清理结果
- [x] 5.3 先为 TUI reducer 编写 turn 创建、增量追加、正常完成、截断、拒答、中断、错误、输入恢复和迟到 `turn_id` 丢弃测试
- [x] 5.4 实现协议无关的终端状态 reducer、单调耗时计算和 usage 保留，费用与上下文比例不得估算或展示

## 6. Ink 全屏 TUI

- [x] 6.1 先编写组件测试，覆盖静态小狗、Weave 版本、工作目录、`protocol / model`、唯一 transcript、固定 composer/status 和未实现状态留空
- [x] 6.2 实现 Ink 7 alternate-screen 应用骨架和 Claude Code 风格单页布局，确保页面只存在一个对话滚动区域
- [x] 6.3 先编写等待首片段、逐段输出、完成耗时、截断、拒答、取消半截文本和错误展示测试，再实现纯文本转录渲染
- [x] 6.4 先编写 `Enter` 提交、`Shift+Enter` 换行、多行粘贴、生成时可编辑但不可并发提交的输入测试，再实现 composer
- [x] 6.5 先编写 `Ctrl+C` 首次取消或清空、2 秒内再次退出、超时重置以及退出后恢复终端的测试，再实现全局退出状态机
- [x] 6.6 先编写默认自动跟随、用户上滚暂停、回到底部恢复和输入增长不产生第二滚动区的测试，再实现 transcript viewport
- [x] 6.7 先编写终端缩小到 `80×24` 以下和恢复尺寸的状态保持测试，再实现尺寸提示与响应式布局
- [x] 6.8 通过 composition root 接通配置、LLM 客户端、对话管理器与 TUI，并验证交互层没有直接导入供应商 SDK 或操作模型历史

## 7. 确定性跨终端 E2E

- [x] 7.1 建立可独立启动的确定性假流 TUI fixture，提供多片段、两轮历史、慢流、错误和取消场景
- [x] 7.2 编写 Windows `psmux` E2E，发送真实按键并捕获 pane，验证启动布局、两轮流、`Shift+Enter`、双 `Ctrl+C`、滚动、尺寸变化和正常退出
- [x] 7.3 在 Windows pane 捕获中断言只出现一个头部、转录不覆盖或交错、输入框与状态栏不形成第二滚动区
- [x] 7.4 编写 WSL2 Ubuntu `tmux` E2E，复用 Windows 场景定义并验证 Linux 下的按键、渲染、尺寸和终端恢复
- [x] 7.5 将确定性 E2E 纳入显式 npm 脚本，确保 session 名称隔离、失败后只清理本测试创建的精确会话且返回可靠退出码

## 8. 真实协议验收与最终门禁

- [x] 8.1 实现显式 live smoke 命令，按参数选择 profile，记录脱敏的协议、模型、片段数、两轮完成状态和 usage，不记录提示词、回答或密钥
- [x] 8.2 在 Windows 使用真实配置分别验证 Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses，每种协议完成两轮、多片段且正常终止
- [x] 8.3 在 WSL2 Ubuntu 使用一个可用 profile 完成真实 TUI 两轮冒烟，验证本地配置路径映射和 Linux 终端交互
- [x] 8.4 运行共享类型、配置、三个适配器、记忆层、引擎层、TUI 与集成测试的完整套件，并分别记录 focused 与 full-suite 结果
- [x] 8.5 运行 `npm run typecheck`、`npm run build`、Windows `psmux` E2E、WSL `tmux` E2E 和 `openspec validate add-multi-protocol-llm-tui-chat --strict`
- [x] 8.6 检查最终 diff、依赖边界、示例配置与测试输出，确认无真实 API Key、无生产或测试数据库连接、无工具/system prompt/持久化等越界实现
