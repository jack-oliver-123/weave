---
status: accepted
---

# 模型通道按内容信任级别固定映射

Weave 的高优先级 system 或等价 developer 通道只包含版本固定并记录摘要的行为协议、安全不变量、控制工具协议，以及由白名单验证的枚举和数值限制。受信 Tool Catalog 通过 Provider 工具定义通道提供 Capability Shaping 后的 schema。任何自然语言、路径、文件名、profile 名或外部字符串都不得插值进入 system 模板。

当前用户输入、Project Instructions、Plan、Public Transcript、Memory 和工作区内容作为保留 Provenance Envelope 的不可信 user 上下文；工具、网页及 MCP 结果使用 tool 通道，但仍明确是不可信数据。权限拒绝只以最小结构化结果进入模型，授权裁决、能力票据和规则详情完全不进入上下文。来源标签、role 和分隔符只帮助模型理解，不能授予权限；Prompt Injection 检测也只能提高风险，最终边界仍由 Action Gateway 与 OS Sandbox 强制。
