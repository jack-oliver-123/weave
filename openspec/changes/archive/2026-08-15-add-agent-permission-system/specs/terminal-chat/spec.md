## ADDED Requirements

### Requirement: 启动界面必须展示权限模式和真实能力

TUI SHALL 在启动状态中显示当前 `read_only | supervised | autonomous` 权限模式、工具配置意图、已认证 sandbox backend 和最终 Capability Report。工具配置为 enabled 但 backend 未认证时 MUST 显示工具不可用及原因，MUST NOT 暗示已获得宿主权限或提供 unsafe fallback。权限模式切换 SHALL 只对新 Task 生效；活动 Task 中不得热切换扩大权限。

#### Scenario: Windows backend 未认证
- **WHEN** 用户在不受支持的 Windows 版本以 tools enabled 启动
- **THEN** TUI 明确显示 sandbox unavailable，业务工具从能力清单移除，并提供继续纯文本或退出的选择

### Requirement: HITL 必须保持单页和唯一滚动区域

授权请求 SHALL 作为结构化事件插入现有唯一对话转录滚动区，展示 Gateway 生成的动作摘要、规范化资源、风险、完整能力清单、命中规则与数据目的地。当前待决项的操作控件 SHALL 复用固定底部操作栏，MUST NOT 创建模态弹窗、侧栏、嵌套列表滚动或第二滚动区域。长授权详情 SHALL 在主转录区折叠或展开，并继续由同一滚动状态管理。

#### Scenario: 多项授权详情超过屏幕
- **WHEN** 一个批次包含多个长路径和能力说明的 ask 项
- **THEN** 详情出现在唯一对话滚动区，底部操作栏保持固定，页面不存在第二个可滚动容器

### Requirement: 授权决定必须逐项且结构化

TUI SHALL 要求用户对每个 ask 项选择 `allow_once`、`allow_for_task` 或 `deny`，并 MAY 提供取消整个权限请求；Task 范围允许只可用于 Gateway 给出的窄范围。界面 MUST NOT 提供无范围 `allow_all`、session/permanent allow 或自然语言“确认”解析。提交 SHALL 包含完整 `taskId + runId + requestId + epoch + actionDigest` 和恰好覆盖所有待决项的决定集合。

#### Scenario: 用户允许一项并拒绝一项
- **WHEN** 同一授权请求包含两个 ask 动作
- **THEN** TUI 在提交前要求两项均有明确选择，并把逐项决定作为一个绑定当前请求的结构化动作发送

#### Scenario: 用户取消授权请求
- **WHEN** 用户选择取消而不是允许或拒绝各项
- **THEN** TUI 发送结构化取消，当前运行以 `PERMISSION_CANCELLED` 收尾且不把任何项记为明确拒绝

### Requirement: 授权等待期间普通输入必须保持 busy

当 ActiveRun 处于 `awaiting_authorization` 时，普通输入框 SHALL 不把文本排队、注入模型或解释为权限决定；界面 SHALL 清楚说明只能完成当前结构化决定或取消。用户原草稿 MAY 保留在本地输入缓冲，但 MUST NOT 改变授权 epoch 或 Pending Authorization。

#### Scenario: 等待授权时用户键入补充要求
- **WHEN** 用户在待授权状态编辑普通文本并尝试提交
- **THEN** TUI 保留草稿并提示当前 busy，不发送普通 turn，也不改变待决请求

### Requirement: 权限拒绝和完整性故障必须呈现不同状态

普通 deny、previously denied、sandbox capability unavailable 和正常票据过期 SHALL 显示为可重新规划的动作失败，并保持 Agent 运行进度；Security Integrity Failure SHALL 显示不可恢复安全终止、已撤销能力及“外部效果是否可能存在”的明确状态。界面 MUST NOT 用同一泛化工具错误混淆二者，也 MUST NOT 展示策略正文、票据、凭据或未授权数据。

#### Scenario: 用户拒绝写文件
- **WHEN** Agent 收到 `PERMISSION_DENIED` 后提出只读替代方案
- **THEN** TUI 先显示写入被拒绝，再继续显示同一 Task 的后续安全进度而不把 Task 标成崩溃

#### Scenario: 结果审计失败
- **WHEN** 动作可能已产生效果但结果审计无法持久化
- **THEN** TUI 显示安全终止和效果可能已发生，不向模型或终端展示未经审计的原始结果
