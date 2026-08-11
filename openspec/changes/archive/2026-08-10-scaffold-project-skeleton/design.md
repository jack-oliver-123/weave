## Context

见 proposal.md — 为什么。当前仓库中无任何源代码，仅有 `.claude/`、`.codex/`、`openspec/` 等配置目录。

## Goals / Non-Goals

**目标：**
- 创建可通过 `tsc --noEmit` 类型检查的 TypeScript 项目配置
- 建立 `src/shared/types.ts` 作为唯一的跨层契约文件
- 为 5 个层各创建最小化的 `index.ts` 存根，仅导出接口类型和未实现的占位实现

**非目标：**
- 任何层的实际业务逻辑实现
- 测试文件（`tests/` 目录在骨架阶段不创建）
- CI/CD 配置
- 安装 npm 依赖（`node_modules`）

## Decisions

### 模块系统：ESM + NodeNext
选择 `"type": "module"` + `"moduleResolution": "NodeNext"`，而非 CommonJS。

**原因：** Anthropic SDK 的最新版本以 ESM 优先发布；NodeNext 解析强制要求显式 `.js` 后缀，与运行时行为一致，可在编译期发现路径错误。

**备选方案：** `"moduleResolution": "bundler"`（适合打包工具场景）——但 Weave 是直接运行的 Node.js 程序，不经过打包，NodeNext 更准确。

### 共享类型：纯类型文件，无运行时代码
`src/shared/types.ts` 只含 `interface` 和 `type` 声明，无 `class`、无函数、无常量。

**原因：** 保持 `shared/` 的零依赖性，任何层都可以安全导入而不引入副作用或循环依赖。

### 层存根：导出接口 + 抛出错误的占位实现
每个 `index.ts` 导出一个与该层对应的接口类型，并导出一个实现该接口的类，所有方法体为 `throw new Error("not implemented")`。

**原因：** 相比空文件或纯注释，可实现的存根能让 TypeScript 立即验证接口签名是否正确，也给后续实现者明确的扩展点。

## Risks / Trade-offs

- `tsc` 要求 `NodeNext` 模式下的相对导入使用 `.js` 后缀，初次接触可能反直觉。**缓解：** 在 `package.json` 的 `scripts` 中统一使用 `tsx` 运行，避免手写导入时犯错。
- 存根抛出运行时错误，若测试意外调用未实现方法会报错。**缓解：** 骨架阶段无测试，可接受。

## Migration Plan

纯新增文件，无现有代码受影响，无需迁移。回滚方式：删除 `src/`、`package.json`、`tsconfig.json` 三项即可完全还原。
