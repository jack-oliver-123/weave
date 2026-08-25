## Why

当前 Linux 认证工作流在 GitHub Ubuntu 24.04 Runner 上连续失败：AppArmor 阻止通用非特权 `unshare`，后端却把 namespace 启动失败折叠为没有诊断信息的 `SANDBOX_UNAVAILABLE`；仓库同时缺少认证签名 Secret，导致失败证据也无法生成。普通 CI 仍然通过且相关 Issue 已被关闭，因此必须恢复真实平台认证与项目状态之间的证据一致性。

## What Changes

- 为 Linux 认证 Runner 配置仅授予 `/usr/bin/unshare` 创建 user namespace 的最小 AppArmor profile，并在运行完整认证前执行明确的 namespace bootstrap 前提检查。
- 让 Linux backend 把 namespace 启动状态作为版本化、安全化的 probe evidence；bootstrap 失败时立即停止 cleanup 探针，并在 `SANDBOX_UNAVAILABLE` 中只公开失败 probe ID，不泄露原始 stderr、宿主路径或环境。
- 让认证工作流分别报告沙箱认证结果与签名配置结果；缺少 `WEAVE_CERTIFICATION_SIGNING_KEY` 时保持失败关闭并给出明确配置错误，不把普通 CI 或无 artifact 状态解释为平台认证通过。
- 将 Linux 当前认证状态从历史 `not_run` 更新为已观测的 `failed`，并要求只有绑定确切提交的远端认证成功与签名 artifact 才能恢复为 `passed`。
- 保持现有安全边界：不增加 `--unsafe`、宿主执行 fallback、特权 Worker 或未签名证据降级。

## Capabilities

### New Capabilities

### Modified Capabilities

- `continuous-integration-quality-gates`: 要求真实 Linux 认证工作流验证并记录 namespace/AppArmor 前提，独立报告签名配置，并以远端签名 artifact 作为通过证据。
- `sandbox-execution`: 要求 Linux namespace bootstrap 成为版本化的必要探针，失败时提供安全化诊断并避免继续执行无意义的 cleanup 探针。

## Impact

- 影响 `.github/workflows/certify-linux.yml`、认证 workflow 契约测试与签名证据生成边界。
- 影响 `src/runner/linux-backend.ts`、`src/runner/runtime.ts`、Capability Report 及相应单元和真实认证测试。
- 更新 `docs/security/certification-status.md`，但不在本 change 中伪造或提交 CI artifact。
- GitHub Actions Secret 配置、commit、push、PR、远端 workflow 调度、Issue 状态、spec sync 和 archive 仍保留独立授权。
