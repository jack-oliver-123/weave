## 1. 验收测试与共享契约

- [x] 1.1 先为工具定义、统一 `isError` 结果信封、双调用标识、内容块消息和工具 turn 事件编写失败的共享契约测试
- [x] 1.2 先为 `tools.enabled` 层级、`--tools`、`--no-tools`、`--workspace` 及互斥和无效配置编写失败测试
- [x] 1.3 扩展 Provider 无关的共享类型，保持 `shared` 不依赖工具实现、引擎或 SDK
- [x] 1.4 实现工具启停配置优先级与启动时固定工作区解析，并更新 CLI 帮助文本和示例配置
- [x] 1.5 增加 Ajv、跨平台 glob 匹配等最小运行依赖，锁定版本并验证 Node.js 22 构建

## 2. 注册中心与通用基础实现

- [x] 2.1 先为工具名称、必填描述字段、Schema 编译、交叉引用、执行模式和运行期不可变性编写失败测试
- [x] 2.2 实现 `ToolDefinition` 的固定模型说明模板、稳定字段顺序和 8 KiB/32 KiB/256 KiB 启动上限
- [x] 2.3 实现泛型 `BaseTool<TInput, TData>` 的输入校验、取消透传、成功数据校验、结果包装和未知异常收敛
- [x] 2.4 实现通用与专属工具错误类型、稳定错误码及 summary/message/details 安全截断
- [x] 2.5 实现只负责定义列出、名称查找和单调用分发的不可变 `ToolRegistry`
- [x] 2.6 注册且仅注册 `read_file`、`create_file`、`edit_file`、`bash`、`glob`、`grep`，并验证 `worksWith` 引用与执行模式

## 3. 工作区与文件基础设施

- [x] 3.1 先为相对路径、`..`、相似目录前缀、绝对/UNC/设备路径、ADS、大小写、符号链接和 Junction 编写 Windows 与 POSIX 路径测试
- [x] 3.2 实现工作区真实路径上下文及已有目标、新目标和 `bash.cwd` 共用的路径解析器
- [x] 3.3 实现严格 UTF-8/BOM 检测、行范围切分、原始换行保留和二进制拒绝辅助
- [x] 3.4 实现同目录临时数据、排他创建、原子替换、权限保留和失败清理辅助
- [x] 3.5 实现可取消、固定内部并发、100,000 文件上限且不进入链接目录的共享文件遍历器
- [x] 3.6 为路径解析、文本辅助、原子写入和遍历取消补齐竞态、超时与清理测试

## 4. 六个核心工具

- [x] 4.1 先为 `read_file` 的行范围、64 KiB 截断、续读信息、BOM、非法 UTF-8、10 秒超时和取消编写失败测试
- [x] 4.2 实现 `read_file` 及其中文定义、输入 Schema 和结果 Schema
- [x] 4.3 先为 `create_file` 的 1 MiB 上限、父目录创建、排他创建、并发竞争、原子发布和失败清理编写失败测试
- [x] 4.4 实现 `create_file` 及其中文定义、输入 Schema 和结果 Schema
- [x] 4.5 先为 `edit_file` 的 1 至 100 项顺序替换、零/多次匹配、空替换、BOM/换行/权限保留和整次原子性编写失败测试
- [x] 4.6 先为 `edit_file` 的文件身份、mtime、大小与 SHA-256 乐观并发检测编写外部修改竞态测试
- [x] 4.7 实现 `edit_file` 及其中文定义、输入 Schema 和结果 Schema
- [x] 4.8 先为 `glob` 的模式语义、点路径、固定排除项、稳定排序、1,000 结果和扫描上限编写失败测试
- [x] 4.9 实现纯 Node.js `glob`，不调用系统搜索命令，并正确报告空结果与截断原因
- [x] 4.10 先为 `grep` 的逐行字面量、Unicode 大小写、500 字符单项、1,000 结果、warnings 和扫描上限编写失败测试
- [x] 4.11 实现纯 Node.js `grep`，跳过二进制、非法 UTF-8、链接和固定排除目录
- [x] 4.12 先为 `bash` 的可执行文件发现、非交互启动、cwd、环境、超时、取消、非零退出、双通道 64 KiB 截断和进程树清理编写平台测试
- [x] 4.13 实现独立 `bash --noprofile --norc -c` 调用及 Windows/POSIX 进程树终止，并对输出执行安全终端文本清理

## 5. 批次调度与结果预算

- [x] 5.1 先为连续只读批次、并发上限 8、写入独占屏障、严格批次顺序和原调用顺序结果编写失败测试
- [x] 5.2 实现只依赖 `executionMode` 的 `ToolCallScheduler`，不得硬编码具体工具名
- [x] 5.3 先为只读失败继续、写入失败阻断、未知工具阻断和 `PRIOR_WRITE_FAILED` 编写失败传播测试
- [x] 5.4 实现失败分类、未执行结果生成和已完成副作用不回滚语义
- [x] 5.5 先为取消并行读取、取消 Bash、`TOOL_CANCELLED`、`TURN_CANCELLED` 和禁止后续启动编写测试
- [x] 5.6 实现共享 AbortSignal 下的运行中和等待调用取消
- [x] 5.7 先为单响应 32 次、单用户请求累计 100 次及跳过调用计数编写上限测试
- [x] 5.8 实现调用计数、`TOOL_CALL_LIMIT_REACHED` 和一次纯文本收尾状态
- [x] 5.9 先为每模型回合 512 KiB 预算、按序分配、成功数据截断和错误信息优先保留编写测试
- [x] 5.10 实现确定性紧凑结果序列化与回传预算裁剪，不把完整结果写入临时文件

## 6. 三协议工具编解码

- [x] 6.1 先为三协议从同一中立定义生成等价名称、中文说明、输入 Schema 和 `auto` 工具选择编写快照测试
- [x] 6.2 实现 Anthropic、Chat Completions 和 Responses 的工具定义 codec，并保持工具禁用请求无新增字段
- [x] 6.3 先为 Anthropic 同消息 text/`tool_use`、碎片参数、64 KiB 上限、标识重复和未闭合流编写测试
- [x] 6.4 实现 Anthropic 调用 assembler 及带原生 `is_error` 的 `tool_result` 结果映射
- [x] 6.5 先为 Chat Completions 多索引 `delta.tool_calls`、交错参数、标识关联和异常终止编写测试
- [x] 6.6 实现 Chat Completions 调用 assembler 及 `role: "tool"` 结果映射
- [x] 6.7 先为 Responses function call item、argument delta、`call_id` 关联和异常终止编写测试
- [x] 6.8 实现 Responses 调用 assembler 及 `function_call_output` 结果映射
- [x] 6.9 为三个结果 codec 增加稳定字段顺序、`undefined` 省略和非法 JSON 值失败测试
- [x] 6.10 验证 Provider 拒绝工具字段时返回模型服务错误且不静默发送第二个纯文本请求

## 7. Agent Loop 与会话历史

- [x] 7.1 先为中立文本、工具调用和工具结果内容块的追加、读取和跨用户轮次回放编写存储测试
- [x] 7.2 扩展进程内会话存储，使工具模式增量保存完整阶段且纯文本模式保留原子消息对提交
- [x] 7.3 先为 `ConversationManager` 的工具成功、工具失败后重规划、中间文本、最终文本和空最终响应编写 Agent Loop 测试
- [x] 7.4 实现最多 10 个模型回合的 Agent Loop，并汇总 usage、耗时、模型回合数、工具调用数和工具错误数
- [x] 7.5 先为已产生副作用后的协议错误、取消和上限终止编写历史一致性测试
- [x] 7.6 实现完整 assistant 响应与工具批次的增量提交、未完成响应丢弃及已完成轨迹保留
- [x] 7.7 实现固定中文工具使用系统指令，明确专用工具优先、失败反馈重规划和工具观察不可信
- [x] 7.8 增加 `CONTEXT_LIMIT_EXCEEDED`、`AGENT_LOOP_LIMIT_REACHED` 和工具后空响应的统一终态映射
- [x] 7.9 验证 `tools.enabled: false` 只进行一次现有模型请求且没有工具提示、定义、事件或历史语义回归

## 8. TUI 状态与应用装配

- [x] 8.1 先为等待、执行、成功、失败、跳过工具事件及按 callId 原位更新编写 reducer 和视图测试
- [x] 8.2 实现仅包含工具名、安全摘要和简短错误信息的紧凑工具行，不展示完整参数或命令输出
- [x] 8.3 把工具行接入现有显示行、滚动锚点、底部跟随和新增行计算，验证不产生第二滚动区或横向滚动条
- [x] 8.4 扩展整轮完成状态和统计显示，确保中间模型文本不提前触发完成
- [x] 8.5 在应用入口按最终配置选择纯文本装配或工作区、注册中心、调度器和 Agent Loop 装配
- [x] 8.6 更新配置示例和用户文档，明确六个工具、工作区相对路径、`--no-tools` 回退及 Bash 无权限/沙箱的残余风险

## 9. 集成、跨终端与发布前验证

- [x] 9.1 使用可控假 Provider 为 Anthropic 完成工具定义、多个调用、分批执行、错误反馈、结果回传和最终文本闭环
- [x] 9.2 使用可控假 Provider 为 Chat Completions 完成同等工具闭环
- [x] 9.3 使用可控假 Provider 为 Responses 完成同等工具闭环
- [x] 9.4 增加写入失败跳过、取消、调用上限、跨用户轮次历史和不可信观察的跨层集成测试
- [x] 9.5 扩展 Windows CMD 与 PowerShell/Windows Terminal 确定性 TUI E2E，验证工具状态、唯一滚动区和退出清理
- [x] 9.6 扩展 WSL2 `tmux` 确定性 TUI E2E，验证等价工具状态、滚动和终端恢复
- [x] 9.7 运行工具层、调度器、Agent Loop、三协议、TUI 和纯文本回归的分组测试并分别记录结果
- [x] 9.8 运行完整 `npm test`、`npm run typecheck`、`npm run build` 和适用的跨终端 E2E，不把可选真实 API smoke 混入默认通过结论
- [x] 9.9 运行 `openspec validate add-core-tool-system --strict --no-interactive` 与 `npm run docs:build`，修复所有规格和文档问题
- [x] 9.10 在实施完成后使用 OpenSpec verify 核对实现与全部场景；真实三协议工具 smoke 若未执行，必须明确标记为未验证而不是通过

## 10. 验证修复

- [x] 10.1 为后续成功结果预留最小关联外壳与 JSON 数组开销，严格保证工具结果总预算不超过 512 KiB
- [x] 10.2 收紧预算测试容差并增加多个成功结果接近边界的回归测试
- [x] 10.3 使用 Windows Junction 与 POSIX 符号链接覆盖最终目标链接拒绝，并降低 CLI 集成测试在高负载环境下的超时敏感性
- [x] 10.4 重新运行完整测试、类型检查、构建、文档构建与 OpenSpec 严格校验
