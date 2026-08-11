---
name: wiki-sync
description: "同步 OpenSpec 变更到 WIKI，并初始化或修复 docs/openspec 链接与 VitePress 文档入口。触发时机：变更创建（openspec new）或归档（openspec archive）后，或 WIKI 同步因文档链接、构建环境失败时。"
---

# 同步 OpenSpec 变更到 WIKI

OpenSpec 变更与 `docs/changes/` 下的 WIKI 页面必须保持同步。

## 触发时机

| 操作 | 文档同步 |
|------|---------|
| 创建新变更 | 创建 WIKI 页面到 `docs/changes/active/` |
| 归档变更 | 移动 WIKI 页面到 `docs/changes/archive/` |

## 确定性入口

从仓库根目录执行：

```bash
npm run docs:link
python3 .codex/skills/wiki-sync/scripts/sync_wiki.py active <change-name>
python3 .codex/skills/wiki-sync/scripts/sync_wiki.py archive <change-name-or-archive-name>
python3 .codex/skills/wiki-sync/scripts/sync_wiki.py all
npm run docs:build
```

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

### 模式一：新建变更同步

1. **验证变更存在**：检查 `openspec/changes/{name}/` 目录。
2. **创建 WIKI 页面**：在 `docs/changes/active/{name}/` 下创建 `index.md`，使用 VitePress 的 `@include` 指令引用 proposal、design、tasks 和 delta specs。项目通过 `docs/openspec` 链接访问根目录 `openspec`。
3. **更新 Sidebar**：在 `docs/.vitepress/config.mts` 的“进行中”分组中添加条目。
4. **更新索引**：同步 `docs/changes/index.md`。
5. **验证 include**：检查页面中的每个 `@include` 目标文件存在。
6. **输出完成摘要**。

### 模式二：归档变更同步

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

### WIKI 页面结构

页面使用 VitePress frontmatter 和 include 指令引用 OpenSpec 变更文件。

**Active 页面 frontmatter**：

```yaml
---
title: change-title
status: active
createdDate: YYYY-MM-DD
---
```

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
- 使用相对路径的 `@include` 指令引用 OpenSpec 内容。
- 操作前验证路径有效性；`docs/openspec` 只接受解析到仓库根目录 `openspec` 的符号链接或 Windows junction。
- 替换损坏链接前必须确认链接路径和真实目标，只删除链接本身，禁止递归删除目标目录。
- 归档时强制检查 delta specs 存在性和同步状态。
- 未经用户明确允许，不得使用 `--allow-unsynced` 绕过同步检查。
- 归档页面禁止引用归档前的 `openspec/changes/{name}/` 路径。
- VitePress 构建成功不代表 include 有效，必须单独检查 include 目标文件。
- `docs/changes/index.md`、`docs/.vitepress/config.mts`、`docs/changes/` 与 `openspec/changes/` 必须保持一致。
