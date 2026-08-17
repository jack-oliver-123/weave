# sandbox-execution Specification

## Purpose

定义所有有副作用或可接触非公开数据的工具如何在可验证的操作系统隔离边界内执行，并规定工作区事务、资源预算、网络代理、凭据代理以及跨平台失效关闭行为。

## Requirements

### Requirement: 工具执行必须进入经认证的操作系统沙箱

除纯文本且不暴露工具的运行外，系统 MUST 仅在通过运行时能力探测和负向逃逸探针的沙箱后端中执行工具；后端缺失、探测未知、探针失败或平台不受支持时 MUST fail closed，且 MUST NOT 回退到宿主进程、普通子进程或“仅路径检查”的伪沙箱。

#### Scenario: 沙箱后端不可用
- **WHEN** Task 请求包含工具的运行，但目标平台没有通过认证的沙箱后端
- **THEN** 系统拒绝该工具能力，并且仅允许用户显式改为 `--no-tools` 的纯文本运行

### Requirement: Runner 必须分离可信监督面与不可信执行面

系统 MUST 将沙箱执行实现为可信 Supervisor、Task 生命周期的持久沙箱和每个动作新建的 Action Worker；Worker MUST NOT 获得权限策略、审计密钥、凭据、授权控制通道或可复用授权票据，并且 MUST 仅看见该动作能力清单允许的资源。

#### Scenario: 动作 Worker 启动
- **WHEN** Supervisor 接受一个有效动作票据
- **THEN** 它为该动作建立最小能力 Worker，且 Worker 无法读取控制面秘密或其他 Task 的状态

### Requirement: 授权票据必须绑定动作并防止重放

宿主 Action Gateway MUST 使用进程启动时生成的临时 Ed25519 密钥签发授权票据；票据 MUST 绑定 schema 版本、runner、sandbox、task、run、call、动作与能力摘要、策略版本、撤销版本、授权 epoch、nonce 和有效时间。Runner MUST 独立重新规范化动作、重新派生沙箱配置，并在启动 Worker 前原子消费 nonce。签名、身份、摘要或重放校验失败 MUST 作为安全完整性故障终止 Task；正常过期或撤销 MUST 返回可重新预检的普通拒绝结果。

#### Scenario: 已消费票据被再次提交
- **WHEN** Runner 收到 nonce 已消费的有效签名票据
- **THEN** Runner 不启动 Worker，并将事件报告为安全完整性故障

### Requirement: 控制通道必须是本机且双向鉴别的

宿主与 Runner 之间 MUST 使用仅当前操作系统用户可访问的本机 IPC，MUST NOT 暴露 TCP 监听端口，并 MUST 双向校验对端身份；沙箱内业务进程 MUST 无法挂载、继承或连接该控制通道。

#### Scenario: 沙箱进程探测控制通道
- **WHEN** 负向探针尝试从 Action Worker 连接宿主控制 IPC
- **THEN** 连接失败，且该结果是后端认证的必要条件

### Requirement: 工作区写入必须经由事务提交代理

Task 沙箱 MUST 从宿主工作区只读基线和 Task 私有 CoW 层运行，业务工具 MUST NOT 直接修改宿主 inode。每个动作产生的变更集 MUST 先完整校验授权路径、基线身份和内容摘要，再由宿主 Commit Broker 在工作区锁下通过同卷暂存、备份、持久化 journal 和逐路径原子替换提交。提交状态 MUST 使用 `PREPARED -> APPLYING -> COMMITTED -> CLEANED`；崩溃恢复时，`COMMITTED` 之后只清理，之前回滚。无法确定安全恢复时 MUST 进入 `RECOVERY_CONFLICT`，禁止继续写工具并要求用户显式处理。

#### Scenario: 多文件提交中途崩溃
- **WHEN** Commit Broker 在 `APPLYING` 阶段替换部分文件后崩溃
- **THEN** 下次启动根据 journal 回滚整个动作，或在基线已外部变化时进入 `RECOVERY_CONFLICT`，不得把部分变更当作成功结果

### Requirement: 文件系统视图必须消除链接逃逸

沙箱工作区 MUST 拒绝指向工作区外的符号链接、junction、reparse point 和其他链接目标；仅允许解析后仍位于授权根内的内部链接。宿主预存硬链接 MUST 不可在沙箱视图中利用。若平台不能证明该属性，`FilesystemRead` 和 `FilesystemWrite` 相应能力 MUST 不可用。

#### Scenario: 工具读取外部符号链接
- **WHEN** 动作尝试读取工作区内一个指向工作区外的链接
- **THEN** Runner 拒绝访问，并且不会把目标内容返回给模型或终端

### Requirement: 进程必须受生命周期和资源预算约束

动作进程 MUST 默认随动作结束而终止完整进程树；仅显式声明 `lifetime: task` 的进程可持续到 Task 结束，并默认要求 HITL，且其原始能力配置不得扩大。默认预算 MUST 限制为 CPU 不超过宿主 50% 且最多 4 核、内存不超过宿主 50% 且最多 4 GiB、128 PID、动作 120 秒且最多配置到 600 秒、Task 进程 60 分钟、Task 临时与工作区增长 4 GiB、stdout/stderr 各 64 KiB、批次输出 512 KiB、每 Task 网络 512 MiB。产品硬上限 MUST 为 8 核、16 GiB、512 PID、Task 4 小时、磁盘 32 GiB、网络 4 GiB；用户只能在硬上限内配置，项目策略只能进一步收紧。

#### Scenario: 动作超过输出预算
- **WHEN** 进程 stdout 超过动作允许的 64 KiB
- **THEN** Runner 截断并标记结果，继续阻止超额输出进入模型、历史和审计日志

### Requirement: 网络访问必须通过精确目标代理

沙箱 MUST 默认没有原始网络能力。获准的 `NetworkEgress` MUST 通过宿主网络代理，并按实际解析后的 scheme、host、port 和 TLS 状态校验；重定向目标 MUST 作为新动作重新授权。loopback、私网、VPN、链路本地、云元数据、保留地址和本地套接字 MUST 默认拒绝，其中元数据端点及宿主控制地址 MUST 为不可授权的硬拒绝。

#### Scenario: 已授权公网请求重定向到私网
- **WHEN** 代理收到从已授权 HTTPS 主机到私网地址的重定向
- **THEN** 代理不跟随重定向，并要求对新目标重新预检，而私网默认规则使其被拒绝

### Requirement: 凭据只能由宿主代理按引用使用

凭据原文 MUST 仅存在于操作系统凭据存储和宿主 Credential Broker 中；模型、AgentLoop、Runner、Worker、工具参数、工具输出、日志和审计 MUST 仅接触不含秘密的 Credential Reference。Windows MUST 使用 Credential Manager，Linux MUST 使用 Secret Service，WSL2 MUST 使用经鉴别的宿主代理；若安全凭据后端不可用，`CredentialUse` MUST 不可用。

#### Scenario: 带凭据的网络动作执行
- **WHEN** 已授权动作引用一个凭据并调用网络代理
- **THEN** Credential Broker 仅在宿主代理发送时注入秘密，且秘密不会进入沙箱或返回结果

### Requirement: 沙箱后端必须按平台独立认证

Linux 和 WSL2 后端 MUST 使用 bubblewrap 或等价的 user/mount/PID/network namespace 隔离，清空环境并只挂载所需运行时与授权工作区；WSL2 还 MUST 隐藏 `/mnt/c`、WSL interop socket 和 Windows PATH，WSL1 MUST 不受支持。Windows 首版 MUST 仅在 Windows 11 24H2+ 使用 Windows Sandbox CLI 的 Task VM，并以低权限 Action Worker 和 Job Object 加固。其他 Windows 与 macOS 在没有独立认证后端时 MUST fail closed。Node Permission Model、Job Object 或 seccomp 单独使用 MUST NOT 被视为完整沙箱边界。

#### Scenario: WSL2 后端认证
- **WHEN** 系统在 WSL2 启动带工具的 Task
- **THEN** 认证探针证明 Worker 无法看到 Windows 盘、interop 通道或 Windows 可执行路径后才启用工具

### Requirement: 后端认证必须包含主动负向探针

每次安装或后端版本变化后，系统 MUST 验证进程身份、不可见路径、原始网络、环境变量、设备、提权、资源限额、进程树清理、IPC 和 broker 不可见性。任何必需探针的缺失、跳过、未知、超时或意外成功 MUST 使该后端未认证。

#### Scenario: 原始网络探针意外成功
- **WHEN** Action Worker 在未授予 `NetworkEgress` 时成功建立原始 socket 连接
- **THEN** 系统将后端标记为未认证，并拒绝所有后续带工具运行
