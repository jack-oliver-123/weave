# Weave — CodingAgent 项目

## 项目概述

Weave 是一个分层架构的 CodingAgent，设计原则：**每层只管自己的事，各层之间通过清晰接口通信，互不干扰**。

---

## 架构：5 层模型

```
┌─────────────────────────────────────────┐
│          交互层 (Interaction)            │  CLI · Commands · Skills
├─────────────────────────────────────────┤
│           引擎层 (Engine)               │  对话 · 循环 · 提示词
├─────────────────────────────────────────┤
│           工具层 (Tool)                 │  Tools · MCP · Hooks
├─────────────────────────────────────────┤
│           记忆层 (Memory)               │  上下文 · 会话 · 自动记忆
├─────────────────────────────────────────┤
│           安全层 (Security)             │  权限 · 沙箱 · HITL
└─────────────────────────────────────────┘
```

### 交互层 (Interaction Layer)

**职责：** 接收用户输入，渲染输出，管理 Skill/Command 的注册与分发。

- CLI 入口解析（参数、flags、stdin/stdout）
- `/command` 与 Skill 的注册、查找、执行
- 输出格式化（Markdown、流式渲染、进度显示）
- **不负责：** 任何 LLM 调用、工具执行、权限判断

**对下接口：** 向引擎层提交 `UserTurn`（用户输入 + 元数据），接收 `AgentTurn`（流式文本 + tool_use events）。

---

### 引擎层 (Engine Layer)

**职责：** 驱动 Agent 主循环，管理提示词组装，与 LLM API 通信。

- `agentic_loop`：接收 turn，调用 LLM，处理 tool_use 返回，循环直到 end_turn
- 提示词构建（system prompt、消息历史拼装、缓存策略）
- 流式输出解析与事件分发
- **不负责：** 工具的具体实现、权限校验、持久化存储

**对下接口：** 通过 Task 级 `ActionTask` 发起 `ModelExchangeRef` 和 `ProposalBatchRef`，只接收经过 Gateway 守卫的模型事件、授权请求与结构化结果；从记忆层拉取 `ContextSnapshot`。

---

### 工具层 (Tool Layer)

**职责：** 定义并注册业务工具，管理 MCP 连接与工具适配器；有副作用或可接触非公开数据的执行交给认证 Runner。

- 内置工具（Read、Write、Edit、Bash、Glob、Grep 等）的定义与执行适配器
- MCP server 连接管理（stdio / SSE），工具代理转发
- Hook 事件分发（PreToolCall、PostToolCall、Stop 等）
- **不负责：** LLM 通信、对话历史、权限决策（权限判断委托给安全层）

**对下接口：** 向 Action Gateway 提供中立 `ToolDefinition`；业务动作只接受 Gateway 保管的提案引用，经过完整预检后由带票据的认证 Runner 执行。

---

### 记忆层 (Memory Layer)

**职责：** 管理所有形式的信息持久化与上下文供给。

- 会话内消息历史（滚动窗口、自动压缩摘要）
- 跨会话记忆文件（user / feedback / project / reference 类型）
- 上下文优先级组装（CLAUDE.md、memory files、git status、recent changes）
- **不负责：** 何时记忆（由引擎层 / 交互层触发）、安全校验

**对上接口：** 提供 `ContextSnapshot`（当前对话可用的上下文包），接收 `MemoryWriteRequest`。

---

### 安全层 (Security Layer)

**职责：** 所有跨越信任边界的操作的守门人。

- 权限规则引擎（settings.json allowlist / denylist 求值）
- HITL（Human-in-the-loop）：需要用户确认时阻塞并等待响应
- Secure Context、Input/Output Guard、审计、票据和数据披露控制
- Runner 控制面与沙箱策略：限制文件路径、网络、进程等资源访问范围
- **不负责：** 工具的具体实现、对话逻辑

**接口：** 暴露 Task 级深接口 `ActionGateway.openTask(...) → ActionTask`。`ActionTask` 内部组合定义筛选、规范化、五层预检、HITL、审计、签票、Runner 调度、结果守卫和按 destination 独立披露；调用方不得绕过该入口重建动作或原始上下文。

---

## 层间通信原则

1. **单向依赖**：业务编排从交互层进入引擎层，再进入 Action Gateway；底层存储、工具和 Runner 不反向依赖交互或会话实现。
2. **接口稳定**：跨层通信使用类型化的请求/响应对象，不传递内部实现引用。
3. **安全层例外**：安全层是横切边界，模型交换、业务动作、持久记忆和数据披露都必须经 Task 级 Gateway；认证 Runner 只接受绑定当前 Task/Run/Action 的票据。
4. **记忆层只读于引擎**：引擎层只读取记忆层快照，写入请求由交互层或引擎层在合适时机发起。

---

## OpenSpec 规范

所有通过 OpenSpec Skill 或命令生成的产物（包括但不限于以下文件）正文内容**必须使用中文撰写**：

- `proposal.md`：变更提案
- `specs/<capability>/spec.md`：能力规格
- `design.md`：设计文档
- `tasks.md`：实施任务清单

**中英文边界规则：**

| 类型 | 语言 | 示例 |
|---|---|---|
| openspec 解析关键字（节头、操作符） | **英文，不得翻译** | `## Why`、`## ADDED Requirements`、`### Requirement:`、`#### Scenario:` |
| 正文内容（描述、分析、说明） | **中文** | requirement 描述、rationale、task 说明 |
| 文件名、目录名、代码标识符 | **英文** | `scaffold-project-skeleton`、`UserTurn` |

**必须保持英文的 openspec 关键字（节头）：**

`proposal.md`：`## Why`、`## What Changes`、`## Capabilities`、`### New Capabilities`、`### Modified Capabilities`、`## Impact`

`spec.md`：`## Purpose`、`## ADDED Requirements`、`## MODIFIED Requirements`、`## REMOVED Requirements`、`## RENAMED Requirements`、`### Requirement: <name>`、`#### Scenario: <name>`

`design.md`：`## Context`、`## Goals / Non-Goals`、`## Decisions`、`## Risks / Trade-offs`、`## Migration Plan`、`## Open Questions`

`tasks.md`：`## N. <组名>`（组名可中文）、`- [ ] N.M <任务描述>`（描述用中文）

---

## 开发约定

- 代码注释：只在 WHY 非显而易见时添加，不写 WHAT
- 提交：功能性变更一个 commit，不在 PR 里混入无关清理

---

## 常用命令

- `npm run dev` — 以 tsx 直接跑 `src/main.ts`（无需先 build）
- `npm run typecheck` — `tsc --noEmit`，提交前必跑的类型门禁
- `npm test` — **先**跑 `tests/ci/workflow-contract.mjs`（工作流契约门禁），**再**跑 vitest；两条都要过
- `npm run test:unit` / `test:integration` / `test:tui` — 按层切分的 vitest 入口
- `npm run spec:validate` — `openspec validate --all --strict --no-interactive`，改 `openspec/` 后必跑
- ESM：`"type": "module"` + `NodeNext`，import 必须带扩展名 `.js`（即使源是 `.ts`）

---

## 约定提醒

- `AGENTS.md` 是占位文件，只写了 "CLAUDE.md" 一行 —— 规范以 `CLAUDE.md` 为准，别被它的存在误导
- `openspec/changes/` 有进行中的变更；改动后跑 `npm run spec:validate` 校验（见上）
- `.weave/`、`.e2e-dist/`、`dist/` 是运行/构建产物，不要手工编辑或提交

---

`shared/` 中只放接口类型和常量，任何层都可以依赖它，但它不依赖任何层。

---

## Agent skills

### 变更流程

开始任何功能、Bug、配置或文档修改前，读取 `docs/agents/openspec-workflow.md`，先报告 `quick`、`standard` 或 `large` 及理由，再遵循对应流程。

### Issue tracker

Issues live in the repo's GitHub Issues; skills use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, each label equal to its name: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root (lazy-created by `/domain-modeling`). See `docs/agents/domain.md`.
