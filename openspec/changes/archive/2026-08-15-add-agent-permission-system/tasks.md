## 1. 安全内核与纯文本纵切片

- [x] 1.1 先建立 fake Provider、fake Runner、内存 Audit Sink 和确定性 ID/clock 测试夹具，再实现封闭的 `ActionGateway.openTask`/`ActionTask.close` 最小生命周期；以一个无工具纯文本 Task 端到端证明资源只在 Task 内存在且关闭后不可复用。 ([#12](https://github.com/jack-oliver-123/weave/issues/12))
- [x] 1.2 为七类 Capability Primitive、NormalizedAction、CapabilityManifest、ProvenanceEnvelope、Gateway Request/Event、Grant、Ticket 和两级错误模型编写 schema 契约测试，再实现只接受已知版本与字段的不可变领域类型。 ([#12](https://github.com/jack-oliver-123/weave/issues/12))
- [x] 1.3 为规范化摘要的跨运行稳定性、域分离和敏感短值不可字典恢复编写属性测试，再实现 action/capability/content/ticket digest 与随机关联 ID 工具。 ([#12](https://github.com/jack-oliver-123/weave/issues/12))
- [x] 1.4 先用 fake Provider 写 `ModelExchangeRef` 纯文本验收测试，再实现 ActionTask 内固定 profile/protocol/model/origin、发起无状态模型交换并返回经守卫的 Gateway 事件。 ([#13](https://github.com/jack-oliver-123/weave/issues/13))
- [x] 1.5 以现有 `--no-tools` TUI 流程写回归测试，再把 ConversationManager 通过兼容 adapter 打开 ActionTask，使纯文本路径走 Gateway 而工具路径暂不启用；验证现有三协议控制终态不回归。 ([#13](https://github.com/jack-oliver-123/weave/issues/13))
- [x] 1.6 在纯文本 Gateway E2E 通过后，删除 AgentLoop 构造函数直接接收 `LlmClient` 和原始 `ChatMessage[]` 的旧入口，并加入静态依赖测试防止重新引入。 ([#13](https://github.com/jack-oliver-123/weave/issues/13))

## 2. 安全上下文与模型数据出口

- [x] 2.1 先写“私有内容不进入 Public Transcript、Task 结束后 Ledger 销毁”的验收测试，再实现 Task 私有 Secure Context Ledger、内容引用和独立 Public Transcript。 ([#14](https://github.com/jack-oliver-123/weave/issues/14))
- [x] 2.2 为 `ordinary < sensitive < credential` 单调传播、项目只能升高和不透明变换继承最高输入分类编写属性测试，再实现 provenance/classification engine 与登记式 contentless trusted adapter。 ([#14](https://github.com/jack-oliver-123/weave/issues/14))
- [x] 2.3 先固定 system/tools/messages 的信任映射快照测试，再改造 Prompt 组装：system 只含固定 Weave 协议与安全标量，项目、Plan、路径、历史、Memory 和运行状态进入 untrusted messages，安全内部状态永不序列化。 ([#14](https://github.com/jack-oliver-123/weave/issues/14))
- [x] 2.4 为用户输入凭据阻断、可选未授权上下文省略和当前输入不得静默删改编写失败测试，再实现 Ledger 接纳阶段 Input Guard 与临时缓冲销毁。 ([#14](https://github.com/jack-oliver-123/weave/issues/14))
- [x] 2.5 为适配器引入未授权 header/body 字节、模型 origin 漂移和 credential pattern 编写测试，再实现 Provider 发送前的最终字节级 Input Guard。 ([#14](https://github.com/jack-oliver-123/weave/issues/14))
- [x] 2.6 为 ordinary 重叠窗口流式发布、sensitive 暂停和 credential 中途阻断编写 fake stream E2E，再实现 Gateway Output Guard，证明未发布字节不进入事件、历史或审计。 ([#14](https://github.com/jack-oliver-123/weave/issues/14))
- [x] 2.7 先写“读取获准但 model disclosure 被拒绝”的端到端测试，再实现按内容摘要/来源、purpose 和 destination 绑定的独立 `DataDisclose` 动作。 ([#14](https://github.com/jack-oliver-123/weave/issues/14))
- [x] 2.8 为 Public Transcript 跨 Task 回流保持 sanitized/untrusted、历史中的“已批准”不产生 grant 编写回归测试，再切换 ConversationStore 只保存公开内容。 ([#14](https://github.com/jack-oliver-123/weave/issues/14))

## 3. 模型提案保管与 AgentLoop 接入

- [x] 3.1 为三协议 tool-call delta 的完整、非法 JSON、重复 ID 和流中断场景编写契约测试，再把 proposal assembler 移入 Gateway，使原始参数只进入受控存储。 ([#15](https://github.com/jack-oliver-123/weave/issues/15))
- [x] 3.2 为 `ProposalBatchRef` 的 task/run/iteration/exchange/epoch/digest 绑定、一次消费、过期和重放编写攻击测试，再实现不透明引用仓库与安全动作描述。 ([#15](https://github.com/jack-oliver-123/weave/issues/15))
- [x] 3.3 先写 AgentLoop 只能提交 `ModelExchangeRequest | ActionBatchRequest(ref)` 的类型与运行测试，再用 ActionTask 替换 ToolExecutor 调用；保持 ReAct/Plan 迭代、调用预算和结果顺序。 ([#15](https://github.com/jack-oliver-123/weave/issues/15))
- [x] 3.4 为工具定义按 Agent 阶段、权限模式和 Capability Report 共同收紧编写测试，再让 ActionTask 返回最小工具集；运行时仍对伪造或过期提案重新强制校验。 ([#15](https://github.com/jack-oliver-123/weave/issues/15))
- [x] 3.5 在 ActionTask 工具路径 E2E 通过后，删除 AgentLoop 到 ToolExecutor、ToolRegistry、Provider 原生事件和原始工具结果的可达依赖，并加入架构测试阻止旁路。 ([#15](https://github.com/jack-oliver-123/weave/issues/15))

## 4. 五层授权决策内核

- [x] 4.1 为灾难性工作区根删除、宿主安全资源、设备/IPC、提权、凭据披露和资源炸弹编写 hard-deny 表驱动测试，再实现版本化 Command Risk Check；其他高风险只产生风险或 ask。 ([#16](https://github.com/jack-oliver-123/weave/issues/16))
- [x] 4.2 为绝对路径、`..`、UNC、设备路径、ADS、外部 symlink/junction/reparse point 和大小写边界编写跨平台测试，再实现 Action Gateway 的 Path Capability Boundary。 ([#16](https://github.com/jack-oliver-123/weave/issues/16))
- [x] 4.3 为 `~/.weave/security.yaml` 所有权/ACL/普通文件校验及工作区 `.weave-policy.yaml` 禁止 allow 编写测试，再实现用户策略和项目收紧策略的独立加载器与版本化 snapshot。 ([#16](https://github.com/jack-oliver-123/weave/issues/16))
- [x] 4.4 为规则无代码/无正则/无否定/无顺序语义、`deny > ask > allow > no_match` 和逐能力 allow coverage 编写属性测试，再实现类型化 Permission Rule matcher/merger。 ([#16](https://github.com/jack-oliver-123/weave/issues/16))
- [x] 4.5 为 `read_only | supervised | autonomous` 完整能力矩阵和不存在 `full_access` 编写契约测试，再实现 Permission Mode fallback；验证可信精确 allow 只能覆盖模式、不能覆盖 hard deny/path/OS。 ([#16](https://github.com/jack-oliver-123/weave/issues/16))
- [x] 4.6 先写固定五层调用顺序和短路语义测试，再实现 Batch Authorization Preflight，证明整个模型批次在所有 ask 解决及执行前审计完成前对 Runner 零调用。 ([#16](https://github.com/jack-oliver-123/weave/issues/16))
- [x] 4.7 为 One-time/Task-scoped Grant 的窄范围、每调用独立 ticket、新自然语言推进 epoch、HITL 不推进 epoch 和即时 revoke 编写状态机测试，再实现 Task Authorization State。 ([#16](https://github.com/jack-oliver-123/weave/issues/16))
- [x] 4.8 为显式 deny 指纹、`PREVIOUSLY_DENIED`、实质参数变化重新预检和 cancel 不写拒绝缓存编写测试，再实现 Task-scoped denial memory。 ([#16](https://github.com/jack-oliver-123/weave/issues/16))
- [x] 4.9 用同一动作覆盖 allow/ask/deny/no-match 与 capability 缺失组合的属性测试验证最终裁决，并确认任何应用层 allow 只产生“可签票”状态而不直接执行。 ([#16](https://github.com/jack-oliver-123/weave/issues/16))

## 5. HITL、会话状态与 TUI

- [x] 5.1 先写多 ask 项集中发布、逐项决定完整覆盖和缺失/额外/重复/过期决定保持等待的状态机测试，再实现 Pending Authorization 与 `resolveAuthorization` 绑定校验。 ([#17](https://github.com/jack-oliver-123/weave/issues/17))
- [x] 5.2 为同一 `runId` 挂起恢复、等待期间零模型调用/零动作、普通输入 busy 和匹配决定后继续原批次编写 AgentLoop E2E，再实现 `authorization_requested` 事件与 ActiveRun suspension。 ([#17](https://github.com/jack-oliver-123/weave/issues/17))
- [x] 5.3 为 Plan 审批不产生任何 capability grant、计划动作仍逐项预检编写回归测试，再隔离 Plan approval 与 Authorization State。 ([#17](https://github.com/jack-oliver-123/weave/issues/17))
- [x] 5.4 先写 ConversationManager 对 `resolve_authorization`、普通输入、问题回答、计划决定和取消的路由矩阵，再实现 `awaiting_authorization` TaskAction 与 epoch 推进规则。 ([#17](https://github.com/jack-oliver-123/weave/issues/17))
- [x] 5.5 先写“一个授权批次超过屏幕仍只有对话区滚动”的 TUI 布局测试，再在唯一转录区渲染动作、资源、风险、能力、规则和 destination，复用固定底部操作栏且不增加弹窗或第二滚动区。 ([#17](https://github.com/jack-oliver-123/weave/issues/17))
- [x] 5.6 为 `allow_once | allow_for_task | deny | cancel` 逐项键盘交互、无 allow-all/session/permanent 入口和普通草稿本地保留编写 TUI E2E，再实现结构化决定提交。 ([#17](https://github.com/jack-oliver-123/weave/issues/17))
- [x] 5.7 为普通拒绝继续 ReAct、调用/迭代预算计数和 Security Integrity Failure 终止 Task 编写端到端测试，再实现两类结果在 AgentEvent、turn 生命周期和 TUI 中的不同呈现。 ([#17](https://github.com/jack-oliver-123/weave/issues/17))
- [x] 5.8 为授权等待、Runner 执行和 Task 进程期间的 cancel/revoke 编写竞态测试，再统一取消域、撤销未使用票据、终止进程树并保证终态后无迟到事件。 ([#17](https://github.com/jack-oliver-123/weave/issues/17))

## 6. 安全审计屏障

- [x] 6.1 先用包含 prompt、路径、命令、stdout/stderr 和短凭据的恶意 fixture 验证零正文泄露，再实现工作区外、当前用户 ACL 的按日 JSONL Audit Sink 与域分离关联 ID。 ([#18](https://github.com/jack-oliver-123/weave/issues/18))
- [x] 6.2 为默认 30 天/100 MiB、可配置 1-365 天且最多 1 GiB、轮转清理不经 Agent 编写时钟和容量测试，再实现可信宿主 retention manager。 ([#18](https://github.com/jack-oliver-123/weave/issues/18))
- [x] 6.3 为 preflight/HITL 审计失败时零 ticket、Supervisor 审计失败时零 nonce 消费/零 Worker 编写故障注入测试，再把 durable pre-execution audit 接入签票与 Runner 顺序。 ([#18](https://github.com/jack-oliver-123/weave/issues/18))
- [x] 6.4 为动作可能已生效但 outcome audit 失败编写 E2E，再实现结果释放屏障、Task 终止、票据撤销和“效果可能已发生”本地状态。 ([#18](https://github.com/jack-oliver-123/weave/issues/18))
- [x] 6.5 为 ordinary 只读批次共享 flush 但逐动作可关联、任一条失败整批零执行编写测试，再实现批量 durable audit。 ([#18](https://github.com/jack-oliver-123/weave/issues/18))
- [x] 6.6 为审计目录、事务 journal、备份和安全配置不可被模型工具发现或读取编写硬拒绝与 sandbox 不可见测试，再加入安全内部资源注册表。 ([#18](https://github.com/jack-oliver-123/weave/issues/18))

## 7. Runner 控制面、票据与资源模型

- [x] 7.1 为本机 IPC 无 TCP 监听、当前用户 ACL、双向身份校验和 Worker 无法连接控制通道编写集成测试，再实现版本化 Runner protocol 与 host/supervisor handshake。 ([#19](https://github.com/jack-oliver-123/weave/issues/19))
- [x] 7.2 为进程启动临时 Ed25519 key、ticket 全字段绑定、签名验证、时窗和域分离编写契约测试，再实现 Ticket Issuer/Verifier；私钥只留宿主 Gateway。 ([#19](https://github.com/jack-oliver-123/weave/issues/19))
- [x] 7.3 为 NormalizedAction 在 Runner 端独立重算、profile 独立派生和 Worker 不接收 ticket 编写 fake backend E2E，再实现 Supervisor、Task Sandbox、Action Worker 生命周期骨架。 ([#19](https://github.com/jack-oliver-123/weave/issues/19))
- [x] 7.4 为 nonce 原子消费、并发重放、摘要/身份不匹配、正常过期和 revocation version 变化编写攻击测试，再实现持久于 Task 的 nonce/revocation store 与两级错误映射。 ([#19](https://github.com/jack-oliver-123/weave/issues/19))
- [x] 7.5 为默认与产品硬上限的 CPU、内存、PID、时长、磁盘、输出和网络预算编写边界测试，再实现资源配置校验与最小 profile 派生；项目配置只能收紧。 ([#19](https://github.com/jack-oliver-123/weave/issues/19))
- [x] 7.6 为动作进程默认销毁、显式 `lifetime: task` 默认 ask、原 profile 不扩大和 Task 关闭杀死进程树编写 fake backend 测试，再实现 Task process registry。 ([#19](https://github.com/jack-oliver-123/weave/issues/19))
- [x] 7.7 先定义 `CapabilityReport` 和 `passed|failed|not_run|skipped|unknown|flaky` 认证证据契约，再实现启动探针汇总；任何未知、缺失或失败都移除对应能力。 ([#19](https://github.com/jack-oliver-123/weave/issues/19))

## 8. Linux 与 WSL2 只读能力切片

- [x] 8.1 在 Linux 上先写宿主路径、环境、设备、提权、原始网络、控制 IPC 和进程树负向 E2E，再实现 bubblewrap Task Sandbox/Action Worker 最小后端；所有探针通过前不发布工具能力。 ([#20](https://github.com/jack-oliver-123/weave/issues/20))
- [x] 8.2 在 WSL2 上为 `/mnt/c`、Windows PATH、interop socket 和启动 Windows exe 编写逃逸探针，再实现 WSL2 专用挂载与环境配置；检测到 WSL1 时 fail closed。 ([#20](https://github.com/jack-oliver-123/weave/issues/20))
- [x] 8.3 先写从 AgentLoop 提案到 sandbox `read_file`、独立 model disclosure 和有序结果的真实 OS E2E，再迁移 `read_file` 到 Runner，并证明宿主文件工具实现不可达。 ([#21](https://github.com/jack-oliver-123/weave/issues/21))
- [x] 8.4 为 glob 的点目录、固定排除、链接、扫描/结果上限和稳定排序编写真实 sandbox 测试，再迁移 `glob` 到 Runner。 ([#21](https://github.com/jack-oliver-123/weave/issues/21))
- [x] 8.5 为 grep 的 UTF-8、二进制/不可读跳过、链接、字面量、稳定排序和输出预算编写真实 sandbox 测试，再迁移 `grep` 到 Runner。 ([#21](https://github.com/jack-oliver-123/weave/issues/21))
- [x] 8.6 在三个只读工具通过认证后删除宿主执行 adapter，加入静态依赖与运行时断言，证明 backend 不可用时只能返回 `SANDBOX_UNAVAILABLE` 或纯文本而无 fallback。 ([#21](https://github.com/jack-oliver-123/weave/issues/21))

## 9. CoW 工作区与事务写入切片

- [x] 9.1 为宿主只读基线、Task 私有 CoW、内部链接、外部链接和预存硬链接不可利用编写 Linux/WSL2 E2E，再实现 Task workspace view 与 change-set 提取。 ([#22](https://github.com/jack-oliver-123/weave/issues/22))
- [x] 9.2 为单文件 create/edit 的 ticket、授权路径、baseline identity/hash、同卷 staging/backup 和逐路径 atomic rename 编写故障注入测试，再实现 Commit Broker 的 `PREPARED -> APPLYING -> COMMITTED -> CLEANED` journal。 ([#22](https://github.com/jack-oliver-123/weave/issues/22))
- [x] 9.3 为多文件动作在每个替换点崩溃、回滚全部已替换路径和 COMMITTED 后仅清理编写可重复 fault matrix，再扩展 Commit Broker 支持完整 Action Change Set。 ([#22](https://github.com/jack-oliver-123/weave/issues/22))
- [x] 9.4 为外部编辑导致 pre/post 均不匹配编写恢复测试，再实现启动恢复扫描、`RECOVERY_CONFLICT`、写能力禁用和显式用户恢复入口；不得自动覆盖用户数据。 ([#22](https://github.com/jack-oliver-123/weave/issues/22))
- [x] 9.5 先写 `create_file` 从模型提案、supervised HITL、Worker CoW 到宿主提交的真实纵切片 E2E，再迁移工具并保持 exists/UTF-8/父目录/输出契约。 ([#23](https://github.com/jack-oliver-123/weave/issues/23))
- [x] 9.6 先写 `edit_file` 唯一匹配、顺序多编辑、外部变化和整动作零部分提交的真实 E2E，再迁移工具并保持原结果契约。 ([#23](https://github.com/jack-oliver-123/weave/issues/23))
- [x] 9.7 在两个写工具切换后删除直接宿主写入、临时替换和旧 Workspace 写 adapter，加入静态检查证明只有 Commit Broker 可写宿主工作区。 ([#23](https://github.com/jack-oliver-123/weave/issues/23))

## 10. 进程与 Bash 能力切片

- [x] 10.1 先为固定 executable/argv/cwd 的结构化进程写 supervised/autonomous 模式、最小文件能力、无原始网络和结果披露 E2E，再实现 Runner structured process adapter。 ([#24](https://github.com/jack-oliver-123/weave/issues/24))
- [x] 10.2 为 raw shell 的灾难性删除、设备/控制面、提权、凭据读取、fork/resource bomb 和普通高风险命令编写规范化/风险测试，再实现 Bash Manifest 推导与第一层 hard deny/risk 标记。 ([#25](https://github.com/jack-oliver-123/weave/issues/25))
- [x] 10.3 先写清空宿主环境、显式安全 PATH、关闭 stdin、无 PTY/原始网络/控制 IPC 的真实 OS E2E，再把 `bash --noprofile --norc -c` 迁入独立 Action Worker。 ([#25](https://github.com/jack-oliver-123/weave/issues/25))
- [x] 10.4 为 stdout/stderr 各 64 KiB、批次 512 KiB、超时最大 600 秒、PID/CPU/内存/磁盘上限编写资源攻击测试，再把预算应用到 shell Worker 和完整进程树。 ([#25](https://github.com/jack-oliver-123/weave/issues/25))
- [x] 10.5 为状态 0、非零但合法变更提交、超时/取消/撤销丢弃当前未提交 CoW、先前动作保持编写真实 E2E，再实现 shell result/commit/cancel 协调。 ([#25](https://github.com/jack-oliver-123/weave/issues/25))
- [x] 10.6 为 `lifetime: task` 的默认 ask、固定原 profile、60 分钟默认、Task 结束/即时 revoke 清理编写 E2E，再接入 Task process registry。 ([#25](https://github.com/jack-oliver-123/weave/issues/25))
- [x] 10.7 Bash 认证通过后删除宿主 `spawn('bash.exe'|'bash')` 和环境继承路径，加入源码扫描和行为测试证明不存在普通子进程 fallback。 ([#25](https://github.com/jack-oliver-123/weave/issues/25))

## 11. 网络、凭据、Provider 与 Memory 切片

- [x] 11.1 为精确 scheme/host/port、实际 DNS、TLS、网络预算和默认无 raw socket 编写 fake DNS/HTTP 集成测试，再实现宿主 Egress Broker 与 `NetworkEgress` ticket 校验。 ([#26](https://github.com/jack-oliver-123/weave/issues/26))
- [x] 11.2 为重定向重新授权、DNS rebinding、loopback/私网/VPN/链路本地/保留地址、云元数据和本地 socket 编写攻击测试，再实现连接时地址复核与 hard-deny target registry。 ([#26](https://github.com/jack-oliver-123/weave/issues/26))
- [x] 11.3 先用内存 secret store 建立 Credential Reference、目标代用范围、秘密仅在最终发送边界短暂存在和零日志/零模型/零 Runner 泄露 E2E，再实现 Credential Broker 接口。 ([#27](https://github.com/jack-oliver-123/weave/issues/27))
- [x] 11.4 为 Windows Credential Manager 的 set/get/delete/list metadata 编写平台集成测试，再实现 Windows adapter；不可用时只移除 CredentialUse 而不回退明文。 ([#27](https://github.com/jack-oliver-123/weave/issues/27))
- [x] 11.5 为 Linux Secret Service 和 WSL2 经鉴别宿主代理分别编写平台集成测试，再实现两个 adapter；验证 sandbox 看不到 keyring 与代理控制通道。 ([#27](https://github.com/jack-oliver-123/weave/issues/27))
- [x] 11.6 先写隐藏输入/stdin、list 不回显、明文 `api_key` 拒绝和 `${ENV}` 仅警告迁移的 CLI/config 测试，再实现 `credential set|delete|list` 与 profile `credential` 字段。 ([#27](https://github.com/jack-oliver-123/weave/issues/27))
- [x] 11.7 为固定 provider profile/protocol/model/origin、跨主机 redirect、fallback 和热切换拒绝编写三协议测试，再让 Provider 请求只通过 ModelExchange envelope 和 Credential Broker 发送。 ([#28](https://github.com/jack-oliver-123/weave/issues/28))
- [x] 11.8 为 Anthropic、Chat Completions、Responses 的原始 tool calls/文本流只进入 Gateway、AgentLoop 只见安全事件编写三协议闭环 E2E，再删除 adapter 向上层暴露原生载荷的路径。 ([#28](https://github.com/jack-oliver-123/weave/issues/28))
- [x] 11.9 先写 MemoryPersist 在三种模式中的 deny/ask、Task 结束 Ledger 销毁和跨 Task 仅持久化已授权净化内容 E2E，再把 Memory 写入接入 Action Gateway。 ([#29](https://github.com/jack-oliver-123/weave/issues/29))
- [x] 11.10 使用含 canary 凭据、敏感文件、Prompt 注入、恶意工具输出和网络外传目标的综合 E2E，证明 secret 不进入模型、普通进程、终端、历史、审计或未授权网络。 ([#29](https://github.com/jack-oliver-123/weave/issues/29))

## 12. Windows Sandbox 后端切片

- [x] 12.1 为 Windows 11 24H2+、Windows Sandbox CLI 版本、特性状态和不支持平台 fail-closed 编写探测测试，再实现 Windows backend Capability Probe 与 Task VM 生命周期。 ([#30](https://github.com/jack-oliver-123/weave/issues/30))
- [x] 12.2 为 Task VM 的禁网默认、显式工作区只读基线/CoW 映射、控制通道身份和宿主其他路径不可见编写 E2E，再实现受控 VM 配置与映射。 ([#30](https://github.com/jack-oliver-123/weave/issues/30))
- [x] 12.3 为 VM 内低权限 Action Worker、Job Object 的进程树/CPU/内存/PID/时长限制和动作结束清理编写 E2E，再实现 Windows worker supervisor。 ([#30](https://github.com/jack-oliver-123/weave/issues/30))
- [x] 12.4 在 Windows backend 运行设备、注册表、宿主路径、网络、环境、提权、IPC、Broker 和子进程逃逸负向矩阵；任一未知、跳过或意外成功都使能力未认证。 ([#30](https://github.com/jack-oliver-123/weave/issues/30))
- [x] 12.5 先认证 `read_file/glob/grep` 的完整 AgentLoop-to-OS 纵切片并生成绑定 commit/OS/backend/probe 的证据，再启用 Windows 只读 Capability Report。 ([#31](https://github.com/jack-oliver-123/weave/issues/31))
- [x] 12.6 分别为事务写入、结构化进程、Bash、网络和凭据运行独立 Windows 认证任务；只启用通过的单项能力，未运行项保持不可见而不继承 Linux 结果。 ([#31](https://github.com/jack-oliver-123/weave/issues/31))

## 13. CI、旁路清理与发布验证

- [x] 13.1 把规则/模式、状态机、摘要、分类、Guard、审计、ticket、事务和 fake E2E 的确定性测试加入普通必过 CI；固定或保存 fuzz/property seed，并确认无真实 Provider、凭据或特权依赖。 ([#32](https://github.com/jack-oliver-123/weave/issues/32))
- [x] 13.2 新增 Linux 真实 backend 认证 workflow 与证据 artifact，严格区分 passed/failed/not_run/skipped/unknown/flaky，且不把该任务缺失解释为基础 CI 通过。 ([#33](https://github.com/jack-oliver-123/weave/issues/33))
- [x] 13.3 新增 WSL2 与 Windows 11 24H2+ 独立认证 workflow/runner 文档和证据 artifact；每个证据绑定 commit、OS、backend、probe 版本和能力切片。 ([#33](https://github.com/jack-oliver-123/weave/issues/33))
- [x] 13.4 为安装后 backend 二进制替换、OS/版本漂移、探针缺失和旧证据重放编写启动测试，再实现运行时对认证前提的重新验证与能力收缩。 ([#33](https://github.com/jack-oliver-123/weave/issues/33))
- [x] 13.5 建立架构/源码扫描测试，禁止 AgentLoop 直连 LlmClient/ToolExecutor/Runner、业务工具宿主执行、SystemReminder 动态提权、raw network、宿主 bash spawn、明文 key 和 unsafe fallback。 ([#34](https://github.com/jack-oliver-123/weave/issues/34))
- [x] 13.6 更新用户配置、权限模式、HITL、Credential CLI、平台支持、纯文本降级、审计保留、恢复冲突和认证状态文档；所有示例不得包含真实秘密或声称未运行 backend 已通过。 ([#34](https://github.com/jack-oliver-123/weave/issues/34))
- [x] 13.7 运行类型检查、lint、完整测试、OpenSpec strict validation、文档链接/构建和三协议 fake E2E；分别记录普通 CI、Linux/WSL2/Windows 认证的 passed/failed/not_run 状态。 ([#34](https://github.com/jack-oliver-123/weave/issues/34))
- [x] 13.8 在所有已启用切片验证通过后执行最终 expand-contract 清理，删除弃用 ToolExecutor 宿主路径、ConversationStore 模型上下文路径和动态 SystemReminder 权限语义；验证本 major 仅保留带警告的 `${ENV}` 迁移入口，并将其移除留给下一 major 的独立变更，随后复跑完整安全与旁路测试。 ([#34](https://github.com/jack-oliver-123/weave/issues/34))
