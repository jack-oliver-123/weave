## Context

Weave 当前已有分层 TypeScript/Node.js 结构、进程内对话存储、`ConversationManager`、三种流式 LLM 适配器和 Ink 单页 TUI。`src/tool/index.ts` 仅保留 `ToolLayerStub`，共享契约仍只支持 user/assistant 纯文本；三种协议目前会把非文本内容视为错误，主规格也明确禁止 system prompt 和工具定义。

本变更跨越 `shared`、`config`、`tool`、`engine`、`memory` 和 `interaction`，并需要同时保持 `tools.enabled: false` 的现有纯文本路径。工具直接运行在用户本地工作区，本次没有权限审批或沙箱，因此必须把工作区路径、资源上限、取消、错误脱敏和不可信工具观察作为工具系统自身的最小边界，而不能误称为完整安全系统。

## Goals / Non-Goals

**Goals:**

- 建立 Provider 无关、启动时不可变、可验证的六工具注册和调用契约。
- 让具体工具只实现经过校验后的核心逻辑，复用输入校验、错误转换、路径解析、文本读取、原子写入、取消和结果包装。
- 用确定性的批次调度和 Agent Loop 完成三协议的 `tool call -> tool result -> final text` 闭环。
- 完整保存可关联的模型回合和工具轨迹，同时保持现有单 turn 对外语义及纯文本兼容。
- 在 Windows、WSL 和 Linux 上获得一致的文件搜索、路径边界、超时、截断和错误行为。

**Non-Goals:**

- 不实现权限规则、HITL、沙箱、命令 allowlist、网络限制或 Bash 命令正文分析。
- 不实现 MCP、插件、动态工具、用户工具或工具配置热更新。
- 不实现历史压缩、跨进程持久化、执行审计、自动重试或服务端会话链。
- 不实现跨调用事务、自动回滚、Diff、Undo、Git 自动提交或 Bash 副作用恢复。
- 不实现 PTY、交互式命令、持久 Shell、后台任务或 Bash 输出实时流。

## Decisions

### 1. 中立契约属于 `shared`，执行实现属于 `tool`

在 `src/shared/types.ts` 或其无 SDK 依赖的拆分模块中定义 `ToolDefinition`、`ToolCallRequest`、`ToolCallResult`、消息内容块、工具流事件和执行模式。中立请求同时保存 Weave 内部 `callId` 与 Provider 原始 `providerCallId`；中立结果使用必填 `isError`。

`src/tool/` 持有 `BaseTool<TInput, TData>`、`ToolRegistry`、工作区解析器、文件遍历器、原子写入辅助和六个具体工具。`BaseTool` 的固定管线为：校验输入 -> 调用 `run()` -> 校验成功数据 -> 结果包装；预期异常映射为稳定工具错误，未知异常收敛为 `INTERNAL_TOOL_ERROR`。

选择这一方案是为了保持现有“跨层只共享类型，不共享实现”的依赖原则。替代方案是让每个工具直接接受和返回 Provider SDK 类型，但这会复制三套 Schema、错误和结果映射，也会阻碍独立测试，因此不采用。

### 2. `ToolRegistry` 只集中管理单工具，调度器独立编排

注册中心构造时一次性接收六个工具，使用 Ajv 编译输入和成功结果 Schema，验证名称、大小、交叉引用与执行模式，再对定义和集合深度冻结。注册中心提供稳定的 `listDefinitions()`、`get()` 和 `dispatch()`；`dispatch()` 不负责批次、历史或模型循环，并预留未来在实际执行前插入授权检查的边界，本次不注入“永远允许”的伪安全层。

`ToolCallScheduler` 只读取注册定义中的 `executionMode`：连续 `read_shared` 调用进入并发上限为 8 的批次，`write_exclusive` 各自成为屏障。调度器维护原始索引并按索引返回结果，处理未知工具、写入失败后的跳过、取消、调用计数和 512 KiB 结果预算。

替代方案是让 `ToolRegistry` 同时承担编排和 Agent Loop。该方案表面集中，但会把工具生命周期、对话状态与 Provider 逻辑耦合到一个中心对象，难以独立验证，因此不采用。

### 3. JSON Schema 是运行时边界，TypeScript 泛型是开发期边界

每个工具定义直接持有受控 JSON Schema，并把对象的 `additionalProperties` 设为 `false`。Ajv 在注册阶段预编译 Validator，调用时不重复编译；`BaseTool` 同时持有 TypeScript 输入/输出泛型，使具体实现不需要手写类型断言。结果 Schema只描述成功 `data`，统一结果信封由基础实现保证。

模型可见 description 由一个纯函数按固定模板从结构化字段生成，三种协议复用同一输出文本和输入 Schema。description、Schema、结果 JSON 均使用确定性字段顺序，便于快照测试。

替代方案是仅依赖 TypeScript 或在 description 中用自然语言描述参数。前者不能校验模型运行期输入，后者无法作为可测试事实来源，因此不采用。

### 4. 工作区解析器执行真实路径边界，而不是字符串前缀检查

应用启动时解析并固定 `WorkspaceContext`，包含启动目录、真实工作区绝对路径和平台路径比较规则。所有文件工具与 `bash.cwd` 只接受相对路径。已有目标通过 `lstat` 和 `realpath` 校验；新目标从最近存在的父目录向上解析，再逐段构造候选路径。路径包含空字节、绝对/UNC/设备路径、Windows ADS、逃逸或最终链接时，在访问前失败。

路径边界使用 `relative(realWorkspace, realTarget)` 判断，而不是简单字符串 `startsWith`；Windows 比较先规范化大小写，返回模型的路径统一转换为相对 `/` 形式。搜索遍历使用 `lstat` 且不进入链接目录。

替代方案是只做 `resolve(root, input).startsWith(root)`。它无法正确处理相似目录前缀、链接、Junction 与平台特殊路径，因此不采用。

### 5. 共享受控文件遍历器支撑 `glob` 与 `grep`

实现一个异步、可取消的工作区遍历器，统一处理 `.git`、`node_modules`、点路径、链接、100,000 文件上限和固定内部并发。`glob` 使用 `minimatch` 之类的纯 Node.js 模式库处理 `*`、`**`、`?`、字符组和花括号；`grep` 复用遍历器并逐文件进行严格 UTF-8、逐行字面量搜索。两者在收集结果后执行稳定排序并应用 1,000 项上限。

遍历器不调用 `rg`、系统 grep、PowerShell 或 Bash，因此工具契约不依赖用户机器是否安装外部搜索程序。内部并发也必须受控，避免外层调度并发 8 个搜索时形成无界文件读取。

替代方案是直接运行 `rg`。其性能更好，但版本、默认忽略、二进制判断、编码、输出和取消在各平台不完全一致，也会把 Bash 之外的工具建立在外部程序上，因此不采用。

### 6. 文件写入采用单调用原子性和乐观并发保护

`create_file` 先验证最近存在父目录，创建缺失目录后在目标目录写入临时内容，再以排他创建/发布语义保证目标不会被覆盖。失败清理只涉及本调用临时数据和本调用创建且仍为空的目录。

`edit_file` 一次读取完整且不超过 1 MiB 的文件，记录 `lstat` 身份、大小、mtime 与内容 SHA-256，在内存按声明顺序预演全部唯一精确替换。落盘前重新读取元数据与哈希；身份或内容变化即返回 `FILE_CHANGED_DURING_EDIT`。全部校验通过后，在同目录写入临时文件、保留原权限并原子替换。BOM 与原始换行通过基于原始字符串替换自然保留。

替代方案是直接 `writeFile` 或逐项写盘。它们会造成覆盖竞态、半写入或部分编辑，不符合失败无副作用的单调用契约，因此不采用。

### 7. Bash 使用独立进程树和有界双通道缓存

每次调用查找平台上的 Bash，使用 `--noprofile --norc -c`、关闭 stdin、设置受校验 cwd 与 `CI=1`，继承其余环境。stdout 和 stderr 同时持续读取，分别保留最多 64 KiB 并继续排空后续数据，防止管道反压阻塞进程。超时和取消共用 AbortSignal 适配，Windows 与 POSIX 分别使用可测试的进程树终止实现。

命令完成后才产生一次工具结果；TUI 仅消费开始和完成状态，不消费原始流。该设计避免未经清理的终端控制序列干扰 Ink，也符合单滚动区约束。

### 8. Agent Loop 由 `ConversationManager` 编排，协议客户端保持单回合无状态

扩展 `LlmRequest`，使其接收中立消息历史、可选工具定义、工具选择模式和同一 AbortSignal；扩展流事件以表达完整 assistant 内容块，但协议客户端每次仍只处理一个模型回合，不执行工具、不访问历史存储。

`ConversationManager` 在工具启用时驱动：记录用户消息 -> 请求模型 -> 流式发布文本 -> 正常结束后记录完整 assistant 消息 -> 调度工具 -> 记录工具结果 -> 再请求模型。循环状态持有模型回合数、工具调用数、错误数、usage 和最终收尾模式。中间文本实时显示但不产生 `turn_complete`；没有新工具的有效文本才结束用户 turn。

工具禁用时保留现有单请求路径，或通过同一循环的严格分支证明只进行一次请求且不发送工具字段。现有 `submit()`、`cancel()` 和文本事件保持兼容，仅新增工具事件与完成统计。

替代方案是在每个 Provider 适配器中实现 Agent Loop。这样会复制历史、限制、调度和取消逻辑，并使不同协议产生行为差异，因此不采用。

### 9. 历史使用中立内容块并按完整阶段增量提交

将纯文本 `ChatMessage` 扩展为 user/assistant/tool 语义可表达的中立内容块：文本、工具调用和工具结果。存储提供追加完整消息或批次的接口，而不是只提交一对 user/assistant 字符串。

工具启用时，用户消息在循环开始记录；只有正常闭合的 assistant 响应才记录，碎片化未完成响应不记录；每批工具结果完成后立即记录。取消或系统错误不会删除已有轨迹。工具禁用时保留旧有原子消息对提交规则，避免改变纯文本错误恢复行为。

这一选择让下一用户轮次能看到真实副作用及失败原因。替代方案是整轮 Agent Loop 成功后一次性提交，但若文件已修改而后续请求失败，历史会与工作区真实状态脱节，因此不采用。

### 10. 三个 Provider 分别使用专用 codec，生命周期规则保持严格

每个协议适配器增加工具 definition codec、message codec 和 call assembler：

- Anthropic 在一条 assistant 消息内保留 text 与 `tool_use`，结果使用带 `is_error` 的 `tool_result`。
- Chat Completions 组装 `delta.tool_calls`，结果使用 `role: tool` 与原始 `tool_call_id`。
- Responses 组装 function call item 与 argument delta，结果使用 `function_call_output` 与原始 `call_id`。

调用只有在模型响应正常终止后才交给调度器。参数 JSON 解析失败、未知工具和 Schema 失败可以形成关联工具错误；缺标识、同响应标识重复、64 KiB 溢出和未闭合流属于协议错误。结果 codec 在 Provider 边界执行确定性 JSON 序列化。

### 11. 工具事件作为现有对话内容渲染，不创建新视口

Turn 事件增加工具排队、开始、完成和跳过事件，均携带内部 callId、工具名、安全摘要和必要错误摘要。TUI reducer 用 callId 更新已有工具行，列表顺序由首次事件决定，不因并行完成重排。工具行与模型文本统一进入对话显示行模型，因此滚动锚点、底部跟随和新增行提示继续复用现有逻辑。

不新增可折叠详情、stdout 面板或时间线视图。完整结果只进入模型历史；用户界面只显示有助于理解进度的摘要。

### 12. 配置只开放工具启停，工作区只来自进程启动上下文

配置解析增加根级和 profile 级 `tools.enabled`，CLI 增加 `--tools`、`--no-tools`、`--workspace`。先解析配置层级，再应用 CLI 启停覆盖；工作区不写入 YAML，避免配置文件被复制后隐式指向其他目录。固定资源数值集中定义为代码常量而不是用户配置，首版减少组合状态和验收面。

工具关闭时不构造注册中心和调度器，不发送工具 system prompt、definitions 或 tool choice。Provider 拒绝工具字段时不自动降级，避免同一请求在不同能力模式下被隐式重复执行。

## Risks / Trade-offs

- [Bash 没有权限审批和沙箱，可访问工作区外文件、网络与进程] -> 在工具说明、固定系统指令和用户文档中明确风险；工作区边界只对文件工具与 Bash 初始 cwd 作保证，后续以独立 Security 变更接入注册中心执行前边界。
- [工作区内文件可能包含间接提示注入] -> 工具结果保持结构化数据边界，system prompt 明确观察不改变指令优先级；不使用会破坏代码和日志的关键词过滤，同时不夸大该缓解措施。
- [完整工具历史可能很快耗尽模型上下文] -> 单工具和单模型回合结果有界，超限明确返回 `CONTEXT_LIMIT_EXCEEDED`；历史压缩留给 Memory 变更，不静默删除事实。
- [并发搜索可能造成磁盘压力] -> 外层只读并发固定为 8，共享遍历器限制内部并发、文件数、结果数和时间，并周期检查取消信号。
- [Windows 链接、Junction、ADS 和进程树行为复杂] -> 路径和 Bash 终止使用平台专项测试，所有拒绝在实际读取或写入前发生；Windows CMD、PowerShell/Windows Terminal 与 WSL 分开验收。
- [原子替换在特殊文件系统或杀毒软件环境中可能失败] -> 将失败作为结构化工具错误，不退化为非原子覆写；临时文件限定同目录并尽力清理。
- [三个 Provider 的流事件结构不同且兼容网关可能不完整] -> 每个协议独立 assembler 和 fixture 测试；只有完整 `tool result -> final text` 才算该协议通过，不从初始 tool call 推断能力。
- [增量历史改变了工具模式下的失败语义] -> 只在工具启用分支使用新规则，纯文本关闭分支保留现有原子提交回归；测试工作区副作用与历史始终一致。
- [固定限制可能不适合超大仓库] -> 首版优先确定性和防失控；截断信息指导模型缩小范围，后续有实际证据后再开放配置。

## Migration Plan

1. 先扩展共享类型、配置解析和存储接口，并用兼容适配保持现有纯文本测试通过。
2. 引入 Schema 校验、工作区解析、通用基础工具和六个工具，默认在测试装配中显式选择启停，避免中途改变旧 fixture。
3. 引入调度器及独立测试，再扩展中立 LLM 流与三个协议 codec。
4. 将 `ConversationManager` 接入 Agent Loop 和增量历史；保持 `tools.enabled: false` 的单请求回归。
5. 接入 TUI 工具事件、CLI 与应用装配，完成跨终端和三协议假 Provider 闭环。
6. 工具默认启用只在所有本地验收通过后落地；若发布后需要回退，用户可使用 `--no-tools` 或配置 `tools.enabled: false` 恢复纯文本路径。
7. 不自动撤销已经由工具写入的工作区内容；代码级回滚只撤销 Weave 实现，不触碰用户工作区。

## Open Questions

无。影响规格、架构和任务拆分的选择均已在本次设计访谈中确认。
