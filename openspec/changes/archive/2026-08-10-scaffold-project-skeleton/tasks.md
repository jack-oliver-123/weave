## 1. 项目配置

- [x] 1.1 创建 `package.json`，声明 `@anthropic-ai/sdk`、`typescript`、`vitest`、`tsx` 依赖
- [x] 1.2 创建 `tsconfig.json`，目标 ES2022，`moduleResolution: NodeNext`，`strict: true`，输出至 `dist/`

## 2. 共享类型契约

- [x] 2.1 创建 `src/shared/types.ts`，导出 `UserTurn`、`AgentEvent`、`ToolCallRequest`、`ToolCallResult`、`ContextSnapshot`、`MemoryWriteRequest`、`PermissionRequest`、`Decision` 8 个类型定义

## 3. 各层存根

- [x] 3.1 创建 `src/interaction/index.ts`，导出 `InteractionLayer` 接口与未实现的占位类
- [x] 3.2 创建 `src/engine/index.ts`，导出 `EngineLayer` 接口与未实现的占位类
- [x] 3.3 创建 `src/tool/index.ts`，导出 `ToolLayer` 接口与未实现的占位类
- [x] 3.4 创建 `src/memory/index.ts`，导出 `MemoryLayer` 接口与未实现的占位类
- [x] 3.5 创建 `src/security/index.ts`，导出 `SecurityLayer` 接口与未实现的占位类

## 4. 验证

- [x] 4.1 执行 `tsc --noEmit`，确认零编译错误
