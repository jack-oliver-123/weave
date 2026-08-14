---
status: accepted
---

# Allow 规则必须逐能力覆盖

Weave 对权限规则采用不对称语义：`deny` 或 `ask` 命中动作或任一能力即可收紧整个动作，`allow` 则只证明其明确匹配的 Capability Requirement 已获准。动作只有在完整 Capability Manifest 被可信 allow 规则共同覆盖，或未覆盖部分由 Permission Mode 明确允许时，才能获得最终 `allow`；项目规则不产生 Allow Coverage。

## Considered Options

- 动作或工具名称命中 allow 后放行完整动作：配置简短，但新增网络、凭据或数据披露能力会被旧规则静默继承。
- 按规则顺序使用首条命中：实现简单，但安全结果依赖文件顺序，并允许后续编辑意外改变更严格规则的效果。
- deny/ask 触发收紧、allow 逐能力举证：配置更明确，但新能力默认保持 `no_match`，不会被既有动作白名单带过。

## Consequences

- `actionKind` 只能限制规则适用范围，不能隐式覆盖动作携带的能力。
- 多条可信 allow 规则可以共同覆盖同一动作的完整能力清单；任何未覆盖能力继续交给其他规则或 Permission Mode 裁决。
- 新增 Capability Primitive 或现有动作新增能力需求时，旧 allow 规则不会自动扩大权限。
