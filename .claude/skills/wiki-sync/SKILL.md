---
name: wiki-sync
description: "为开发者文档站生成 OpenSpec 归档投影，或修复已有 WIKI 的 docs/openspec 链接、include、导航和 VitePress 构建。正常流程仅由 OpenSpec archive 自动触发；不要在 new、propose、apply 或 verify 阶段创建 active WIKI。"
---

# 同步 OpenSpec 变更到 WIKI

OpenSpec artifacts 是唯一事实来源。`docs/changes/` 下的 WIKI 页面只使用 `@include`、索引和导航为开发人员提供只读投影，不复制或改写 OpenSpec 正文。

## 触发时机

| 触发 | 文档同步 |
|------|---------|
| OpenSpec archive 已成功移动变更 | 自动创建或更新 `docs/changes/archive/` 投影，并验证构建 |
| 用户明确要求修复已有 WIKI 故障 | 只修复目标链接、include、导航或构建问题 |

`openspec new`、propose/ff 产物完成、Apply、Review 和 Verify 都不触发 active WIKI。OpenSpec 正文更新会通过 `@include` 直接反映，无需内容复制或额外同步。

## 确定性入口

从仓库根目录执行：

```bash
npm run docs:link
python3 .codex/skills/wiki-sync/scripts/sync_wiki.py archive <change-name-or-archive-name>
npm run docs:build
```

`all` 仅用于用户明确要求的全量故障修复，不属于正常归档流程。正常流程不得调用 `active`。

`npm run docs:link` 必须先成功。同步脚本会生成或更新页面、索引和 Sidebar，并单独验证 delta specs、include 目标与导航一致性。同步完成后仍须执行 `npm run docs:build`。

## 运行前置条件与链接自愈

- 使用 Node.js 22 或更高版本，并在仓库根目录安装锁定版本的 VitePress 依赖。
- `docs/openspec` 必须解析到仓库根目录的 `openspec`。POSIX 使用指向 `../openspec` 的目录符号链接；Windows 允许使用解析到同一目录的 junction。
- 链接属于本机运行时设施，应加入 `.gitignore`，通过 `scripts/ensure-docs-link.mjs` 在克隆后确定性重建，不提交链接本身。
- 始终使用 `npm run docs:link` 初始化或检查链接。该命令在 Windows 创建 junction，在 POSIX 创建相对符号链接，并校验链接的真实目标。
- 不要在 Windows 仓库中使用 WSL `ln -s` 创建供 Windows Node.js 使用的链接。WSL 可能创建 Windows 进程无法读取的 Linux reparse link，VitePress 随后会报 `EACCES`。
- PowerShell 原生 `New-Item -ItemType SymbolicLink` 可能要求管理员权限或启用开发者模式；遇到权限错误时使用项目的 `docs:link` 命令，不要求提权。

如果仓库尚无 VitePress 工程，先创建最小入口：根目录 `package.json`、`docs/index.md`、`docs/.vitepress/` 生成目录忽略规则，以及 `docs:link`、`docs:dev`、`docs:build`、`docs:preview` 脚本。固定使用稳定版 VitePress，不使用 `next` 或 alpha 版本。同步脚本只负责 WIKI 内容和结构校验，不应假设它会完成这些工程初始化工作。

## 工作流程

### 模式一：归档自动投影

1. **验证归档变更存在**：在 `openspec/changes/archive/` 下查找匹配目录，支持完整名称或简短名称自动匹配日期前缀。
2. **强制检查 delta specs**：
   - 检查归档变更目录下是否存在 specs；不存在则阻断并提示用户创建或显性声明跳过。
   - 检查 delta specs 是否已同步到 main specs；未同步则询问用户选择同步或跳过。
   - 仅当用户显性声明跳过时才可使用脚本的 `--allow-unsynced` 绕过检查。
3. **移动或创建 WIKI 页面**：将 active 页面移至 `docs/changes/archive/{date}-{name}/`，更新 frontmatter 状态。
   - frontmatter 统一使用 `title`、`status`、`createdDate`、`archivedDate`。
   - 归档页 `@include` 必须指向 `../../../openspec/changes/archive/{date}-{name}/...`。
   - 禁止保留 `../../../openspec/changes/{name}/...` 这类归档前路径。
4. **更新 Sidebar**：从“进行中”移除，添加到“已归档”。
5. **更新索引**：同步更新 `docs/changes/index.md`，保持与 Sidebar 顺序一致。
6. **验证 include**：任一目标缺失时阻断。
7. **验证构建**：执行 `npm run docs:build`；构建通过后仍需保留 include 目标存在性检查结论。
8. **输出完成摘要**。

该模式由 `openspec-archive-change` 在归档目录移动成功后自动调用，不再次询问 WIKI 授权。若投影或构建失败，OpenSpec 仍保持已归档事实；报告 WIKI 未同步并保留可重试命令，不得自动把 change 移回 active。

### 模式二：已有 WIKI 故障修复

1. **确认修复范围**：只处理用户指出或构建实际报告的链接、include、导航或 VitePress 问题。
2. **读取 OpenSpec**：从 active/archive 实际目录和 artifact 文件推导投影，不把 WIKI 内容反写为 OpenSpec。
3. **最小修复**：运行目标范围的同步或链接自愈；只有用户明确要求全量修复时才运行 `all`。
4. **双重验证**：单独验证 include/导航一致性并执行 `npm run docs:build`。

### WIKI 页面结构

页面使用 VitePress frontmatter 和 include 指令引用 OpenSpec 变更文件。

**Archive 页面 frontmatter**：

```yaml
---
title: change-title
status: archived
createdDate: YYYY-MM-DD
archivedDate: YYYY-MM-DD
---
```

include 语法：

```markdown
<!--@include: ../../../openspec/changes/archive/YYYY-MM-DD-change-title/proposal.md-->
```

## 常见故障与恢复

| 现象 | 原因 | 恢复动作 |
|------|------|----------|
| `docs/openspec must link to ../openspec` | 链接不存在、类型不受支持或真实目标错误 | 在仓库根目录运行 `npm run docs:link`，再重新同步 |
| `Administrator privilege required for this operation` | Windows 原生符号链接权限不足 | 不提权，改用 `npm run docs:link` 创建 junction |
| Node.js 或 VitePress 对 `docs/openspec` 报 `EACCES` | 链接由 WSL 创建，Windows 进程不能读取该 reparse link | 先确认链接真实目标，只删除损坏的链接本身，再运行 `npm run docs:link`；不得删除目标目录 |
| WIKI 同步成功但 VitePress 构建失败 | 文档工程、依赖、Markdown 或导航仍有问题 | 保留同步结果，单独修复构建错误，然后重新执行同步校验和 `npm run docs:build` |
| VitePress 构建成功但页面缺少 OpenSpec 内容 | 构建成功不能证明所有 include 目标都正确 | 重新运行同步脚本的 include 校验，并核对归档前后路径 |

## Guardrails

- 不修改 OpenSpec 原有文件，只创建或移动 WIKI 页面。
- OpenSpec artifacts 是唯一事实来源；WIKI 不拥有需求、设计、任务或规格正文。
- 正常流程只投影已归档 change，不为 active change 创建页面。
- 使用相对路径的 `@include` 指令引用 OpenSpec 内容。
- 操作前验证路径有效性；`docs/openspec` 只接受解析到仓库根目录 `openspec` 的符号链接或 Windows junction。
- 替换损坏链接前必须确认链接路径和真实目标，只删除链接本身，禁止递归删除目标目录。
- 归档时强制检查 delta specs 存在性和同步状态。
- 未经用户明确允许，不得使用 `--allow-unsynced` 绕过同步检查。
- 归档页面禁止引用归档前的 `openspec/changes/{name}/` 路径。
- VitePress 构建成功不代表 include 有效，必须单独检查 include 目标文件。
- `docs/changes/index.md`、`docs/.vitepress/config.mts` 和 `docs/changes/archive/` 必须与 `openspec/changes/archive/` 保持一致。
