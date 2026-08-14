export const TOOL_USAGE_RULES = Object.freeze({
  preferSpecialized: '优先使用能够直接完成当前操作的专用工具，不要用通用命令绕过已有专用工具。',
  readBeforeEdit: '修改现有文件前，必须在当前任务中读取相关区段和必要上下文；不要求机械读取整个大文件。',
  createNewFile: '创建已确认不存在的新文件前，检查目标路径和同类文件约定，无需读取不存在的目标文件。',
  refreshEvidence: '读取失败、内容已变化或读取证据可能过期时，重新读取后再编辑。',
  generatedFiles: '不要手工编辑自动生成文件；修改其源文件并运行项目生成流程。',
});

export const CONTROL_DECISION_RULES = Object.freeze({
  finishWhenVerified: '每次收到工具结果后，先判断是否已达到终态。若当前范围内的必要工作已完成、最近一次相关验证成功，且没有用户要求的未完成事项或已知阻塞，下一步必须直接调用 complete_task。验证成功后不得再读取已修改文件、重复运行成功验证、扩大调查或创建未要求的文件；只有出现失败证据或尚未满足明确验收标准时才能继续使用业务工具。',
  requestHighImpactAuthorization: '每次收到只读预检结果后，先检查下一项动作是否需要高影响授权。准备提交或推送不等于授权；若提交、推送、创建 PR、部署、删除等高影响操作仍缺少用户明确授权，最多完成直接确认待操作内容所需的 git status、git diff 等最小只读预检，下一步必须调用 request_user_input。不得继续检查无关文件、历史或配置来替代授权确认。',
});

export const CONTROL_DECISION_CHECKPOINT = '已收到新的业务工具结果。选择下一步前先应用终态决策：已完成且验证成功则调用 complete_task；已完成最小只读预检但仍缺少高影响授权则调用 request_user_input；只有两者都不成立时才能继续调用业务工具。';

export function toolUsagePrompt(): string {
  return Object.values(TOOL_USAGE_RULES).join('\n');
}

export function editToolGuidance(): string {
  return [TOOL_USAGE_RULES.readBeforeEdit, TOOL_USAGE_RULES.refreshEvidence, TOOL_USAGE_RULES.generatedFiles].join(' ');
}

export function createToolGuidance(): string {
  return TOOL_USAGE_RULES.createNewFile;
}
