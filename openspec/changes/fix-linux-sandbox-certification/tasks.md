## 1. 修复 namespace bootstrap 诊断

- [x] 1.1 ([#39](https://github.com/jack-oliver-123/weave/issues/39)) 先为非零 bootstrap、无完整 probe 输出、cleanup 短路和安全失败 probe ID 编写失败测试，再实现版本化 `namespace_bootstrap` 必要证据、Linux backend/probe 版本升级与安全化 `SANDBOX_UNAVAILABLE`，并通过 runner 聚焦测试

## 2. 修复 Linux 认证工作流

- [x] 2.1 ([#39](https://github.com/jack-oliver-123/weave/issues/39)) 先扩展认证 workflow 契约测试覆盖 Ubuntu 24.04、固定 `/usr/bin/unshare` 的最小 AppArmor `userns` profile、普通用户 bootstrap 前提检查、签名配置独立失败和 artifact 条件上传，再修改 workflow 与证据版本并通过聚焦契约检查

## 3. 恢复可核验的认证状态

- [ ] 3.1 ([#40](https://github.com/jack-oliver-123/weave/issues/40)) 将 Linux 当前状态更新为绑定两次远端失败运行的 `failed`，运行完整测试、类型检查、lint、构建、严格 OpenSpec 与文档验证；在 Secret、commit、push 和 workflow 调度分别获得授权后，以绑定精确提交的签名 `passed` artifact 完成远端验收，未获得该证据前不得标记通过
