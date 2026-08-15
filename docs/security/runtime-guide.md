# 运行时安全指南

## 启动与降级

带工具启动时，Weave 会重新运行后端探针并按通过的能力切片收缩工具定义。任何必要探针缺失、失败、未运行、跳过、未知或不稳定，都使对应能力不可见。系统没有 `--unsafe` 或宿主执行 fallback；使用 `--no-tools` 明确进入纯文本模式。

Linux 与 WSL2 认证工作流生成绑定 commit、OS、backend 版本、probe 版本和能力切片的 JSON artifact。Windows Sandbox 分别认证低权限 Worker/Job Object 逃逸矩阵、只读纵切片、事务写入、结构化进程和 Bash；Windows Egress Broker 与 Credential Manager 使用独立组件证据。摘要、commit、OS build 或组件版本不匹配时只移除对应能力。

Windows 默认仍使用已认证的 WSL2 backend。要显式选择 Windows Sandbox，可在可信用户配置中设置：

```yaml
security:
  sandbox:
    backend: windows-sandbox
```

该选择不自动安装 Store 版 Sandbox、不提权，也不会在失败后切换到 WSL2 或宿主进程。运行时只从安装根的 `artifacts/certification/` 读取绑定当前 commit 的证据；只读或写入证据缺失时保持纯文本。结构化进程通过但 Bash 未通过时，`ProcessSpawn` 和 `bash` 仍不可见。

## 权限与 HITL

`read_only` 拒绝写入、进程、网络、凭据代用和持久化；`supervised` 对这些动作请求确认；`autonomous` 只自动允许普通文件写入与结构化低风险进程，raw shell、网络、凭据和持久化仍请求确认。明确规则可以收紧默认值；精确可信 allow 只能覆盖它明确匹配的能力，不能覆盖 hard deny、路径或 OS 边界。

Task 内允许只在当前 Task、授权 epoch、动作摘要与能力摘要完全匹配时复用。新的自然语言输入推进 epoch；即时撤销、Task 结束和安全完整性故障会清理资源。

## 凭据与网络

Windows 使用 Credential Manager，Linux 使用 Secret Service，WSL2 仅接受经 HMAC 鉴别的宿主代理。凭据只在最终 Provider 发送边界短暂注入；模型、AgentLoop、Runner、工具结果和审计只接触引用。

Provider 网络发送经 Egress Broker 固定 scheme、host、port 和实际 DNS 地址。连接建立时重新核对远端地址，拒绝重定向、DNS rebinding、loopback、私网、链路本地、保留地址与元数据地址，并执行请求和响应总字节预算。

## 审计与恢复

安全审计必须先持久化，随后才执行动作或披露结果。记录不含 Prompt、文件正文、stdout/stderr 或凭据。保留期支持 1-365 天，容量上限 1 GiB。

事务写入使用 `PREPARED -> APPLYING -> COMMITTED -> CLEANED` journal。启动恢复遇到外部编辑且无法证明 pre/post 状态时进入 `RECOVERY_CONFLICT`；此时只读仍可用，写能力关闭。确认冲突只移除恢复元数据，不会自动覆盖用户文件。

## 认证状态

| 状态 | 含义 | 能力发布 |
| --- | --- | --- |
| `passed` | 必要探针真实执行且全部通过 | 仅发布证据绑定的切片 |
| `failed` | 探针失败或逃逸意外成功 | 不发布 |
| `not_run` | 环境或后端不存在 | 不发布 |
| `skipped` | 认证任务被跳过 | 不发布 |
| `unknown` | 结果无法可信判断 | 不发布 |
| `flaky` | 结果不稳定 | 不发布 |
