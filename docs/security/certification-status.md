# 本地认证状态

记录日期：2026-08-15。该记录描述当前源修订的本地验证；本地认证产物绑定对应 commit、OS、backend 与 probe 版本，发布仍应以认证工作流上传的 CI artifact 为准。

| 验证域 | 状态 | 证据摘要 |
| --- | --- | --- |
| 普通 CI | `passed` | 类型检查、lint、构建、85 个测试文件、555 项测试、OpenSpec strict validation、文档链接与构建通过；另有 7 项环境认证测试按条件跳过 |
| Linux namespace backend | `not_run` | 本次主机不是 Linux；由 `certify-linux.yml` 独立运行 |
| WSL2 namespace backend | `passed` | AgentLoop-to-OS 纵切片通过，认证 `FilesystemRead`、`FilesystemWrite`、`ProcessSpawn`；包含 WSL 挂载、interop、环境、网络、CoW、Bash、超时和输出预算探针 |
| Windows Credential Manager | `passed` | 临时 Generic Credential 的 set/get/list/delete 平台认证通过，测试凭据已删除 |
| Windows Network Egress | `passed` | 真实公网 DNS、固定连接地址、原生 TLS、响应预算和私网目标拒绝通过；修复并覆盖 Node 22 `lookup({ all: true })` 回调 |
| Windows Sandbox backend | `passed` | Store backend `0.8.107.0` 的真实 Task VM 认证通过：低完整性 Worker、Job Object 资源边界、负向隔离矩阵、`read_file/glob/grep`、事务写入和结构化进程均通过；Bash 明确为不可用，因此仅发布 `FilesystemRead` 与 `FilesystemWrite`，不发布 `ProcessSpawn` |

认证状态不是跨平台继承关系。WSL2 通过不能使 Windows Sandbox 的文件、进程、Bash、网络或凭据能力变为可见。
