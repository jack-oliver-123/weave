## Purpose

定义 Weave 项目的初始代码骨架结构，包含 5 层目录、共享类型契约和构建配置，为后续各层实现提供统一的文件布局和导入边界。

## ADDED Requirements

### Requirement: 项目配置文件存在且可用
项目根目录 SHALL 包含 `package.json` 和 `tsconfig.json`，使 `tsc --noEmit` 能够无错误地完成类型检查。

#### Scenario: TypeScript 编译检查通过
- **WHEN** 在项目根目录执行 `tsc --noEmit`
- **THEN** 命令以退出码 0 结束，无编译错误

#### Scenario: 依赖声明完整
- **WHEN** 读取 `package.json`
- **THEN** 文件中包含 `@anthropic-ai/sdk`、`typescript`、`vitest`、`tsx` 的依赖声明

### Requirement: 共享类型模块存在且完整
`src/shared/types.ts` SHALL 导出所有跨层通信所需的类型定义，且不依赖任何层的实现模块。

#### Scenario: 跨层类型全部导出
- **WHEN** 导入 `src/shared/types.ts`
- **THEN** 可访问 `UserTurn`、`AgentEvent`、`ToolCallRequest`、`ToolCallResult`、`ContextSnapshot`、`MemoryWriteRequest`、`PermissionRequest`、`Decision` 这 8 个类型

#### Scenario: 共享模块无层级依赖
- **WHEN** 分析 `src/shared/types.ts` 的导入语句
- **THEN** 不存在对 `src/interaction`、`src/engine`、`src/tool`、`src/memory`、`src/security` 的导入

### Requirement: 5 层目录结构存在
`src/` SHALL 包含 `interaction/`、`engine/`、`tool/`、`memory/`、`security/` 五个子目录，每个目录下各有一个 `index.ts` 入口文件。

#### Scenario: 各层入口文件可被 TypeScript 解析
- **WHEN** 执行 `tsc --noEmit`
- **THEN** 5 个层级的 `index.ts` 文件均无类型错误

#### Scenario: 各层入口文件仅依赖共享类型或下层
- **WHEN** 分析各层 `index.ts` 的导入路径
- **THEN** 不存在违反单向依赖原则的导入（如交互层不导入引擎层实现，引擎层不导入工具层实现等反向依赖）
