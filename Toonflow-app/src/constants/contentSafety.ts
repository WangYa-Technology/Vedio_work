export const CONTENT_SAFETY_SETTING_KEY = "contentSafetyConstraint";

export const DEFAULT_CONTENT_SAFETY_CONSTRAINT = `生成剧本、分镜、图片和视频提示词时，必须执行以下内容安全改写：
- 将血腥、伤口、断肢、喷溅、明确处决等直观伤害描写，改写为非血腥的紧张对峙、压迫感、动作即将发生或动作结果不可见。
- 保留角色、场景、镜头、情绪和叙事目的，尽量保持原有戏剧张力。
- 不新增血液、开放性伤口、肢体残缺、喷溅、斩杀过程等视觉细节。
- 如果原描述无法安全改写，输出可生成的替代表述，不要直接提交原始有害描述。`;
