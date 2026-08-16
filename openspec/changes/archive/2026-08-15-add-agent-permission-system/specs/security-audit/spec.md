## Purpose

定义权限决策、沙箱执行和结果释放的最小化、可追责、耐故障审计协议，同时确保审计本身不会成为提示、文件内容、命令输出或凭据的数据泄露渠道。

## ADDED Requirements

### Requirement: 安全审计必须只记录结构化元数据

审计记录 MUST 仅包含时间、task/run/call/action 标识、动作摘要、能力类别、风险等级、数据分类、命中的规则 ID、权限模式、用户决定、票据标识、沙箱后端、结果状态和错误类别。记录 MUST NOT 包含 prompt、用户文本、文件内容、文件片段、完整命令、stdout、stderr、模型输出、凭据或可逆秘密。

#### Scenario: shell 动作失败
- **WHEN** shell 动作输出包含敏感文本并以非零状态退出
- **THEN** 审计只记录动作摘要、退出类别与执行元数据，不记录命令原文或输出

### Requirement: 审计必须位于工作区和 Agent 能力之外

审计文件 MUST 存储在工作区外、仅当前操作系统用户可访问的位置；Agent、模型、项目工具和沙箱 MUST 无法读取、导出、修改、截断或清理审计。审计 MUST 默认不上传任何远端。

#### Scenario: Agent 请求读取审计目录
- **WHEN** 模型提出读取或导出安全审计的动作
- **THEN** 该目标被视为不可授权的安全内部资源并被硬拒绝

### Requirement: 执行前审计必须先于票据签发

每个动作的预检结论和每次 HITL 决定 MUST 在签发执行票据前持久化。Runner MUST 在消费 nonce 或启动 Worker 前写入最小监督记录。若任一必需的执行前审计无法持久化，系统 MUST 不执行动作并以安全完整性故障终止 Task。

#### Scenario: 审计磁盘在 HITL 允许后不可写
- **WHEN** 用户允许动作但授权记录无法持久化
- **THEN** Gateway 不签发票据，不启动 Worker，并终止当前 Task

### Requirement: 结果审计必须先于结果释放

动作结束后，系统 MUST 在向模型、终端或其他目标释放结果前持久化结果元数据。若动作可能已产生外部效果但结果审计失败，系统 MUST 撤销 Task 所有未使用票据、终止 Task，并明确报告“效果可能已发生、结果未释放”，不得向模型返回未经审计的成功结果。

#### Scenario: 网络请求完成后审计写入失败
- **WHEN** 网络代理已确认请求发送，但结果审计无法持久化
- **THEN** Task 被终止，用户收到外部效果可能存在的本地提示，模型不收到响应内容

### Requirement: 批量只读审计可合并持久化但不得漏项

同一预检批次中的 ordinary 只读动作 MAY 共享一次 durable flush，但每个动作仍 MUST 有独立 action ID、摘要、决策和结果条目；任何批次条目不能持久化时，整批 MUST 不执行。

#### Scenario: 八个只读动作同批预检
- **WHEN** Gateway 对八个 ordinary 只读动作使用一次审计 flush
- **THEN** 审计中存在八个可单独关联结果的动作记录，且 flush 失败时零动作执行

### Requirement: 审计保留必须有受限配置

审计 MUST 按日滚动为结构化 JSONL，默认保留 30 天或总计 100 MiB，以先到者为准。用户 MAY 配置 1 至 365 天且最大 1 GiB；超出产品上限的配置 MUST 被拒绝。轮转与清理 MUST 由可信宿主组件执行，不得通过 Agent 工具调用。

#### Scenario: 用户配置超大保留量
- **WHEN** 用户把审计上限设置为 5 GiB
- **THEN** 配置加载失败并指出允许的最大值 1 GiB

### Requirement: 审计必须与工作区事务 journal 分离

安全审计与 Commit Broker 恢复 journal MUST 使用独立存储、schema 和访问控制。审计用于追责但 MUST NOT 被用作文件恢复依据；事务 journal 包含恢复所需路径元数据但 MUST NOT 暴露给 Agent 或混入可导出的审计记录。

#### Scenario: 工作区事务崩溃恢复
- **WHEN** 系统从 `APPLYING` 状态恢复多文件事务
- **THEN** Commit Broker 仅依据事务 journal 决定回滚或冲突，审计仅追加恢复结果元数据

### Requirement: 审计关联标识必须不可承载秘密

动作、规则、内容和票据关联 MUST 使用带域分离的不可逆摘要或随机标识；摘要输入不得使用可被低成本字典恢复的裸秘密，且日志中的标识不得足以重建文件路径、命令或内容。

#### Scenario: 短凭据触发阻断
- **WHEN** Input Guard 阻断一个短 credential
- **THEN** 审计记录检测类别和随机事件 ID，不记录该凭据的普通哈希
