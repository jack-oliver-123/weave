## Why

Weave 已确定 5 层架构（交互层、引擎层、工具层、记忆层、安全层），但尚无任何源代码。没有项目骨架，后续各层的实现无处安放。

## What Changes

- 新增 `package.json`，声明 TypeScript、Anthropic SDK、Vitest、tsx 依赖
- 新增 `tsconfig.json`，目标 ES2022，NodeNext 模块解析
- 新增 `src/shared/types.ts`，包含跨层契约类型（`UserTurn`、`AgentEvent`、`ToolCallRequest`、`ToolCallResult`、`ContextSnapshot`、`MemoryWriteRequest`、`PermissionRequest`、`Decision`）
- 新增 5 个层的入口存根：`src/interaction/`、`src/engine/`、`src/tool/`、`src/memory/`、`src/security/`，每层各一个 `index.ts`

## Capabilities

### New Capabilities

- `project-skeleton`：TypeScript 项目结构，包含 5 层目录布局、共享契约类型和各层存根入口

### Modified Capabilities

## Impact

- 仅新增文件，不修改任何现有代码
- 确立了所有后续层实现必须遵守的导入边界
- `src/shared/types.ts` 成为稳定性契约——修改它会影响所有层
