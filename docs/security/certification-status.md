# 本地认证状态

记录日期：2026-08-24。该记录汇总当前源修订可用的本地与远端证据；认证产物必须绑定对应 commit、OS、backend 与 probe 版本，发布仍以认证工作流上传并通过签名校验的 CI artifact 为准。

| 验证域 | 状态 | 证据摘要 |
| --- | --- | --- |
| 普通 CI | `passed` | 完整测试套件、类型检查、lint、构建、OpenSpec strict validation、文档链接与构建通过；环境认证测试按条件跳过 |
| Linux namespace backend | `failed` | commit `2431e745` 的定时认证在 [2026-08-17](https://github.com/jack-oliver-123/weave/actions/runs/31992969929) 与 [2026-08-24](https://github.com/jack-oliver-123/weave/actions/runs/32688600543) 均因 namespace bootstrap 不可用而失败；修复提交 `884ac3e` 的 [手动认证](https://github.com/jack-oliver-123/weave/actions/runs/32705185899) 已通过 AppArmor/bootstrap 前提并上传签名 `failed` artifact，但完整切片超过旧 120 秒用例预算，v2 尚无远端签名 `passed` 证据 |
| WSL2 namespace backend | `passed` | 当前 v2 AgentLoop-to-OS 纵切片在本机 129.2 秒通过，认证 `FilesystemRead`、`FilesystemWrite`、`ProcessSpawn`；包含 bootstrap、WSL 挂载、interop、环境、网络、CoW、Bash、超时和输出预算探针 |
| Windows Credential Manager | `passed` | 临时 Generic Credential 的 set/get/list/delete 平台认证通过，测试凭据已删除 |
| Windows Network Egress | `passed` | 真实公网 DNS、固定连接地址、原生 TLS、响应预算和私网目标拒绝通过；修复并覆盖 Node 22 `lookup({ all: true })` 回调 |
| Windows Sandbox backend | `passed` | Store backend `0.8.107.0` 的真实 Task VM 认证通过：低完整性 Worker、Job Object 资源边界、负向隔离矩阵、`read_file/glob/grep`、事务写入和结构化进程均通过；Bash 明确为不可用，因此仅发布 `FilesystemRead` 与 `FilesystemWrite`，不发布 `ProcessSpawn` |

认证状态不是跨平台继承关系。WSL2 通过不能使 Windows Sandbox 的文件、进程、Bash、网络或凭据能力变为可见。
