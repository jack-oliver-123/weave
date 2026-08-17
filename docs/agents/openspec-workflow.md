# OpenSpec 与工程 Skills 工作流

## 责任边界

- OpenSpec 的 `proposal.md`、`specs/`、`design.md` 和 `tasks.md` 是需求、设计、验收标准与实施计划的唯一真相。
- GitHub Issues 是执行镜像：承载任务认领、依赖关系和协作状态，不独立定义或修改需求。
- `/to-spec` 只用于不采用 OpenSpec 的轻量任务。OpenSpec 变更不得再生成第二份 Issue 规格。

## OpenSpec tasks 与 Tickets

- **OpenSpec task** 是 `tasks.md` 中可勾选的实现检查点；它可以是测试、契约、迁移或实现步骤，不等同于 Issue。
- **Ticket** 是 `/to-tickets` 生成的 tracer-bullet 交付与协作单元；一个 Ticket SHALL 覆盖一个或多个相关 OpenSpec tasks。
- 每个未完成 OpenSpec task SHALL 恰好归属于一个负责 Ticket；多个 tasks MAY 共享同一个 Issue URL，一个 task MUST NOT 同时归属于多个 Tickets。
- Ticket 的验收标准 SHALL 从其覆盖的全部 OpenSpec tasks 和其他 canonical artifacts 派生。Issue 不得取代、重写或扩展这些事实来源。
- 不得仅为匹配 Ticket 粒度而拆分、合并或重排 OpenSpec tasks。只有实现检查点本身不完整、不可验证或顺序错误时，才修改 `tasks.md`。

## 流程选择

开始修改功能、Bug、配置或文档前，先选择 `quick`、`standard` 或 `large`，并向用户报告：

```text
Workflow: quick | standard | large
Reason: <命中的判断条件>
Artifacts: <需要的 OpenSpec、Tickets 或 Wayfinder 产物>
```

`standard` 是默认流程。只有同时满足全部 quick 条件时才能降级为 `quick`；判断不确定时升级一级。

### Quick

必须同时满足：

- 不新增能力，不改变现有验收标准。
- 只修改一个局部 module 或 seam。
- 不改变公共接口、共享类型、配置或持久化格式。
- 不涉及认证、权限、安全、凭据、网络或 sandbox。
- 不需要迁移、兼容方案或多阶段发布。
- 只有一个独立行为切片，没有 blocking dependencies。
- focused test 可以完整证明正确性。
- 可以在一个上下文和一个 PR 内完成。

Quick 流程依次执行：确认目标和非目标、确认测试 seam、记录 review 基线、TDD、focused tests、code-review、完整质量门禁。需要 GitHub 跟踪时可显式运行 `/to-spec` 创建一张 Issue；一个切片不运行 `/to-tickets`。

### Standard

命中任一条件即使用本文件后续的完整 OpenSpec 流程：

- 新增或修改用户可观察行为或验收标准。
- 修改公共接口、跨层契约、共享类型、配置格式、数据结构或持久化行为。
- 涉及安全、权限、认证、网络、凭据、sandbox、迁移或兼容性。
- 横跨多个 modules、seams 或运行环境。
- 存在多个 tasks、依赖关系或发布阶段。
- 存在未确认的需求、验收标准或设计取舍。
- focused test 无法独立证明完整正确性。

### Large

命中任一条件时先使用 Wayfinder，再拆成多个可独立验证和归档的 OpenSpec changes；每个 change 分别执行 Standard 流程：

- 包含多个可独立交付的能力。
- 预计需要多个 PR 或多个 Agent 会话。
- 关键技术路线尚未确定。
- research、prototype 或 grilling 之间存在依赖。
- 单个 change 无法形成清晰、可独立验证的完成条件。

## 规划

1. 使用 OpenSpec Explore，并按需使用 `grill-with-docs`、`research`、`prototype` 或 `diagnosing-bugs` 消除未知项。
2. 使用 OpenSpec Propose 生成完整的 proposal、specs、design 和 tasks，并通过 strict validation。
3. 将每个 OpenSpec task 写成明确、可验证的实现检查点；Ticket 再把一个或多个相关 tasks 组织成单个上下文窗口可交付的 tracer-bullet 纵向切片。宽范围机械重构使用 expand-contract 任务链。

## WIKI 投影

1. OpenSpec artifacts 是需求、设计、任务和规格的唯一事实来源；WIKI 只通过 `@include`、索引和导航提供开发者只读投影，不复制正文。
2. `openspec new`、Propose、Apply、Review 和 Verify 阶段不创建 active WIKI 页面。OpenSpec 正文变化直接由 include 读取，不需要内容同步。
3. Change 归档成功后，Archive 流程自动运行 `wiki-sync archive`、include/导航校验和文档构建；归档授权包含该本地投影刷新，不再单独询问 WIKI 授权。
4. WIKI 投影失败不回滚 OpenSpec 归档事实；报告部分完成并保留安全重试入口。已有 WIKI 的手工故障修复仍需用户单独授权。

## 发布 Tickets

1. 用户显式调用 `/to-tickets <openspec tasks.md 路径>`。
2. `/to-tickets` 读取该 change 的全部 artifacts，把一个或多个相关 OpenSpec tasks 聚合为可独立交付的 tracer-bullet Ticket，并为 Ticket 声明 blocking edges。每个未完成 task 必须被覆盖且只能归属于一个 Ticket。
3. 只有 OpenSpec 实现检查点本身需要拆分、合并或重排时，才先展示精确 `tasks.md` 修改方案，经用户批准后修改并执行 strict validation；Ticket 聚合本身不得触发 `tasks.md` 改写。
4. 用户批准 Ticket 拆分后，先只读验证目标仓库、所需标签和依赖能力。缺失配置时停止并报告，不创建 Issue；预检通过后展示每个 Issue 的标题、正文、标签、依赖关系和覆盖的全部 task 编号，取得独立的最终创建确认。
5. 按依赖顺序创建 Issue。每成功创建一个 Issue，立即把同一个 Markdown 链接回写到它覆盖的所有 task 行，格式为 `([#123](https://github.com/<owner>/<repo>/issues/123))`；完整持久化该覆盖集合后再创建下一个 Issue。
6. 两个相关 Issues 都存在后再创建原生 blocking edge。依赖边创建失败时保留已经完成的 task 映射，停止并报告精确缺失边。
7. 重试时先验证已回写的 Issue 链接和覆盖集合，复用有效映射，只补齐未创建的 Issue、未映射的 task 或缺失的依赖边，不回滚或重复创建成功的 Issue。
8. 发布完成后验证每个未完成 task 恰好有一个有效 Issue 映射，同时允许多个 tasks 使用相同 Issue URL；随后再次执行 strict validation。

Issue 正文必须标明 OpenSpec change、覆盖的全部 task 编号和仓库内的 canonical artifact 路径。验收标准来自 OpenSpec artifacts；Issue 不引入新的需求。一个 Issue 覆盖的所有 tasks 完成前，该 Issue 不满足关闭条件。发布期间不关闭或修改已有父 Issue。

## Apply

1. 读取 OpenSpec apply instructions 的全部 `contextFiles`。每个未完成 task 必须已有有效 Issue 映射；缺失时停止并要求先显式运行 `/to-tickets`。
2. 从 tasks 和 contextFiles 识别本次将触及的 seam，向用户确认后再写测试或实现。
3. 记录 `git rev-parse HEAD` 作为本次实现的 code-review fixed point。
4. 按 OpenSpec tasks 的实现顺序领取下一个未完成 Ticket；GitHub Issue 状态只用于协作同步，不构成本地实施门槛。在该 Issue 覆盖范围内按 TDD 逐项完成 OpenSpec tasks：red、最小 green、勾选 task。重构和清理放到 review 返修阶段。
5. Apply 不自动关闭或更新 GitHub Issue，也不写入 blocker 评论、标签或状态。任务状态回写属于单独的远程操作授权；未满足的环境前提只记录在本地 Apply 结果中。

## Review 与验证

1. 所有 tasks 完成后运行 `code-review`：fixed point 使用 Apply 前记录的 SHA，spec source 使用该 change 的全部 contextFiles。
2. 修复 Standards 与 Spec findings，运行相应测试，再重复 review。必须清除所有 hard findings；judgement calls 必须逐项解决或记录明确决定。
3. Review 收敛后运行 OpenSpec Verify，检查 completeness、correctness 和 coherence。发现问题时回到返修循环。
4. Verify 通过后，依次建议 spec sync 和 archive；两步保留独立授权。Archive 成功后自动刷新 archived WIKI 投影并验证文档构建。

## 交付授权

创建或关闭 Issue、commit、push、创建 PR、merge、spec sync、archive 和手工 WIKI 故障修复是相互独立的操作。此前阶段的批准不授权后续阶段；archive 授权只额外包含确定性的本地 WIKI 归档投影与文档构建，不授权其他文档修改或远程操作。
