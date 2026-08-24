## Context

见 `proposal.md`。当前 Linux backend 直接调用非特权 `unshare --user --map-root-user --mount --pid --fork --net`。GitHub `ubuntu-latest` 已解析为 Ubuntu 24.04，其 AppArmor 默认限制通用非特权 user namespace；认证命令因此在进入 namespace 脚本前退出。backend 丢弃该执行的 exit code 与 stderr，把缺失输出映射为全部 probes 失败，然后仍执行最多五秒的 cleanup 探针。认证 workflow 还依赖未配置的 Ed25519 Secret，因此两次定时运行都没有 artifact。

## Goals / Non-Goals

**Goals:**

- 在不全局关闭 AppArmor 的前提下，让临时 GitHub Ubuntu 24.04 Runner 满足 backend 的 user namespace 启动前提。
- 把 bootstrap 失败与后置负向 probe 失败区分开，提供不泄露宿主信息的稳定诊断。
- 让签名配置失败、沙箱测试失败和 artifact 上传状态各自可辨认。
- 让文档、Issue 协作状态和远端认证证据保持同一事实边界。

**Non-Goals:**

- 不以 root、特权容器、全局关闭 AppArmor、旧 Ubuntu 镜像或宿主工具 fallback 规避认证。
- 不在代码库中保存认证私钥，也不自动写 GitHub Secret。
- 不把 WSL2 或 Windows 的本地通过状态继承给 Linux。
- 不在本 change 中实现新的 Linux 安装器或为任意第三方程序开放 user namespace。

## Decisions

### 1. 为固定 `unshare` 可执行文件加载最小 AppArmor profile

认证 workflow 在检测到 `kernel.apparmor_restrict_unprivileged_userns=1` 时，仿照官方 Runner 镜像对 Podman 的处理，为 `/usr/bin/unshare` 加载只包含 `userns` 权限的 AppArmor profile；随后以普通 runner 用户执行最小 namespace bootstrap 检查。选择精确 profile 而不是 `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`，因为后者会扩大整台 Runner 上全部未约束进程的权限。固定 Ubuntu 22.04 只能延迟镜像策略变化，特权容器则不能证明目标无特权 backend 的边界，因此均不采用。

### 2. 新增必要 `namespace_bootstrap` probe 并升级认证版本

Host transport 根据初始 probe 执行是否成功进入隔离脚本、正常退出并产生状态输出，生成 `namespace_bootstrap` evidence。该 probe 加入必要 probe 集；Linux backend 与 probe version 同步升级，避免旧 evidence 被误当作满足新契约。bootstrap 只证明后续探针可以开始，不直接授予能力。

### 3. bootstrap 失败时短路 cleanup

只有初始 bootstrap 成功后才运行进程树 cleanup probe。若启动命令非零退出或没有有效 probe 输出，系统直接把 cleanup 标记为失败并构造 Capability Report。这既消除固定五秒假等待，也避免在宿主前提未知时继续创建进程。

### 4. 错误只携带安全 probe ID

运行时仍以 `SANDBOX_UNAVAILABLE` 作为稳定错误码，但附加排序后的失败 probe ID 供日志与 CI 定位。原始 stderr、exit 命令、路径和环境不进入错误；若未来需要更深诊断，应在受信本地诊断通道中单独提供，不扩大公共错误接口。

### 5. workflow 分离认证、签名配置和 artifact 步骤

完整沙箱测试保持独立 step。无论测试是否通过，后续签名配置检查都明确验证 Secret 是否存在；只有配置有效时才生成与上传签名 outcome artifact。失败测试生成 capabilities 为空的 `failed` artifact，缺少 Secret 则生成独立配置错误且不产生未签名文件。私钥只能由 GitHub Secret 注入，仓库只保留格式与公钥部署说明。

### 6. 远端证据决定 Linux 状态

本地实现阶段把已观测状态记录为 `failed`。只有修复提交进入可调度分支、签名 Secret 已配置且远端工作流上传绑定该提交的 `passed` artifact 后，才能将 Linux 状态更新为 `passed`。普通 CI、单元测试或本机 WSL2 结果均不能完成该门禁。

## Risks / Trade-offs

- [GitHub Runner 再次改变 AppArmor ABI 或可执行路径] -> 前提检查失败关闭，workflow 契约固定 profile 语义但不假定策略永远可加载。
- [AppArmor profile 对该临时 Runner 上所有 `/usr/bin/unshare` 调用生效] -> job 使用 GitHub 托管的单用途临时 VM，profile 只授予 `userns` 且不关闭全局限制；认证后不复用 Runner。
- [安全化错误不足以定位更底层 mount/chroot 失败] -> bootstrap ID 先区分启动阶段与业务 probe；更深原始诊断只在受信诊断通道提供。
- [Secret 未配置使 workflow 继续保持红色] -> 将其作为真实部署前提明确报告，不用临时密钥或未签名 artifact 降级。
- [修改必要 probe 集使旧 evidence 失效] -> 同步升级 backend/probe version，并依赖 fail-closed 加载拒绝旧证据。

## Migration Plan

1. 先增加会捕获非零 namespace bootstrap、cleanup 短路、安全错误详情与 workflow AppArmor/Secret 契约的失败测试。
2. 实现 backend probe/version 与 workflow 修改，运行聚焦测试、完整测试、类型检查、构建和严格 OpenSpec 校验。
3. 将当前 Linux 状态记录为 `failed`，保留两次失败运行链接。
4. 在独立授权下配置 GitHub Actions 签名 Secret，提交并推送修复分支，触发绑定精确提交的远端认证。
5. 只有远端生成签名 `passed` artifact 后才更新状态为 `passed`；若认证仍失败，保留 `failed` 并使用失败 probe ID继续诊断。
6. 回滚时移除 workflow profile 与 backend 新 probe，同时恢复旧版本号；已经生成的新版本 evidence 必须保持不可被旧运行时接受。
