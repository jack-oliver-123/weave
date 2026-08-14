## 1. 请求契约与验收基线

- [x] 1.1 先为八个输入来源、`system/tools/messages` 三字段、静态与动态 System 分离、扩展 usage 和审计元数据补充类型级测试
- [x] 1.2 将 shared 中的 `LlmRequest.systemPrompt` 及分散的 `messages/tools` 入口替换为唯一结构化 Prompt 组装契约，并用编译错误清点全部迁移调用点
- [x] 1.3 为静态提示、SystemReminder、环境快照、运行时状态、预留 `WEAVE.md`/记忆/Skill 输入槽和 `capability_change` 建立封闭判别联合，确认本阶段没有加载器或真实 MCP 连接路径

## 2. 静态七模块

- [x] 2.1 先编写静态模块注册表验收测试，覆盖七个完整 ID、固定顺序、单空行分隔、重复 ID、重复优先级、空内容、模块版本与稳定哈希
- [x] 2.2 实现身份、系统约束、任务模式、动作执行、工具使用、语气风格、文本输出七个中文固定模块及显式冲突裁决规则
- [x] 2.3 增加静态 Prompt 快照并审阅角色、软授权边界、证据原则、跨项目代码质量、语言、精简务实和不使用表情符号等契约，避免重复规则与仓库专属内容

## 3. SystemReminder 与环境边界

- [x] 3.1 先编写动态容器测试，覆盖 `runtime_state -> environment -> activated_skill -> project_instructions -> memory` 顺序、空片段省略、来源与 trust 保留及无反向标签解析
- [x] 3.2 先编写环境白名单与注入边界测试，覆盖六类允许字段、Git/日志/命令输出过滤、标签闭合文本、XML 特殊字符、无效控制字符和工具结果冒充运行时状态
- [x] 3.3 实现结构化片段构造器、确定性排序与转义序列化，使首版只开放可信运行时状态和白名单环境输入
- [x] 3.4 实现稳定段哈希、完整组装哈希及安全审计投影，只暴露版本、模块/片段元数据、字符数和 usage，不记录任何 Prompt、对话、工具结果或密钥正文

## 4. AgentLoop 模式与完成语义

- [x] 4.1 先扩展 PromptBuilder/AgentLoop 单元测试，覆盖 ReAct 默认、显式 Plan、四个阶段、迭代预算、当前计划步骤、成功标准、已有证据和协议纠正动态片段
- [x] 4.2 实现稳定模式协议与每轮紧凑完整运行状态的分离，移除按阶段重建不同静态 Prompt 的旧路径，不引入轮次间隔重复策略
- [x] 4.3 增加行为契约测试，固定先调查可查事实、关键歧义才询问、诊断评审默认只读、变更请求实施验证、高影响操作询问但不宣称权限系统
- [x] 4.4 回归 `complete_task`、`request_user_input`、Plan 提交/步骤/收尾和迭代硬停止，确保验证摘要区分通过、失败、未运行与外部阻塞，且局部验证不会被当作全任务完成

## 5. 工具说明与最小能力暴露

- [x] 5.1 先补充共享工具规则测试，覆盖专用工具优先、修改现有文件前读取相关区段、新文件路径与同类约定检查、过期重读及生成文件源头修改
- [x] 5.2 从同一权威规则生成静态工具模块短规则与相关工具专属说明，保持语义一致且不复制完整工具文档到 SystemReminder
- [x] 5.3 回归各 AgentLoop 阶段最小业务与控制工具集合，确认缓存策略不会暴露不可调用工具，且工具开关关闭时仍保留控制工具
- [x] 5.4 为预留的 MCP `capability_change` 补充类型与序列化测试，确认只有可信运行时且影响当前任务的事件可进入 Reminder，本次没有真实 Server 上下线实现

## 6. 三协议请求映射

- [x] 6.1 先为 Anthropic Messages 编写结构化 System 映射测试，覆盖稳定段在前、动态段在后、工具与历史分离，以及只有明确支持时才发送原生缓存控制
- [x] 6.2 先为 OpenAI Chat Completions 编写高优先级消息映射测试，覆盖官方能力与兼容端点回退，并禁止把 SystemReminder 降级为 user 消息
- [x] 6.3 先为 OpenAI Responses 编写 `instructions`/高优先级输入与缓存能力映射测试，继续禁止 `previous_response_id` 和隐式重放探测
- [x] 6.4 迁移三个 codec 与客户端到结构化 PromptAssembly，删除旧 `systemPrompt` 入口并更新协议快照、假 SDK 和拒绝工具字段测试

## 7. 缓存 usage 与可观测性

- [x] 7.1 先为 Anthropic 的 `cache_read_input_tokens`、`cache_creation_input_tokens` 以及 OpenAI 原生缓存明细编写解析测试，区分真实 `0` 与字段缺失
- [x] 7.2 实现 `cacheReadInputTokens`、`cacheWriteInputTokens` 归一化，并更新 AgentLoop、ConversationManager 与终态事件逐项聚合可选 usage
- [x] 7.3 更新 live smoke，使同一稳定前缀至少连续请求两次并脱敏记录协议、模型、Prompt 版本、哈希及真实缓存读写指标；指标缺失时输出“不可验证”而非未命中或通过

## 8. 集成验收与人工对比

- [x] 8.1 迁移全部单元、集成、TUI 假客户端和快照到新请求契约，并回归三协议 ReAct/Plan 工具闭环、取消、恢复、上限与私有历史筛选
- [x] 8.2 增加确定性端到端契约测试，验证八来源三字段不串流、静态前缀跨动态状态保持不变、敏感正文不进入审计及缺失缓存指标保持未知
- [x] 8.3 准备并执行人工对比清单：专用工具优先、编辑前读取、信息不足、诊断只读、变更后验证、危险操作询问、工具观察提示注入；关联场景 ID、协议、模型、Prompt 版本、工具轨迹、延迟和 usage，不生成自动质量分数
- [x] 8.4 运行 `npm run test:unit`、`npm run test:integration`、`npm run test:tui`、`npm test`、`npm run typecheck`、`npm run build` 与 `npm run spec:validate`，分别报告确定性测试、可选真实缓存 smoke 和人工评估状态
- [x] 8.5 检查最终 diff、Prompt 快照、Provider 请求快照和日志输出，确认没有 API Key、Prompt/对话正文、权限系统、项目指令加载、自动记忆、Skill 加载、真实 MCP 或自动评分越界实现
- [x] 8.6 根据 PQ-06/PQ-07 反馈补充收敛与授权边界契约测试，将规则同步到静态模块和控制工具说明，并递增 Prompt 与受影响模块版本
- [x] 8.7 运行确定性门禁并仅复测 PQ-06/PQ-07，追加脱敏工具轨迹、延迟、usage 与人工结论；保留未通过事实且不引入自动评分或权限系统
