import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VIDEO_PROMPT_ACTION,
  DEFAULT_VIDEO_PROMPT_FAITHFUL,
} from "./videoPromptDefaults";

for (const [name, template] of [
  ["叙事张力型", DEFAULT_VIDEO_PROMPT_FAITHFUL],
  ["高冲突动作型", DEFAULT_VIDEO_PROMPT_ACTION],
] as const) {
  test(`${name} includes the learned consistency and physical-feedback rules`, () => {
    assert.match(template, /四层一致性锚点/);
    assert.match(template, /角色锚点/);
    assert.match(template, /场景锚点/);
    assert.match(template, /光影锚点/);
    assert.match(template, /媒介锚点/);
    assert.match(template, /物理反馈|物理因果/);
    assert.match(template, /随机文字/);
    assert.match(template, /参考项必须/);
    assert.match(template, /旁白的职责是制造冲突|旁白在开场制造矛盾|旁白制造矛盾/);
    assert.match(template, /不能只作背景说明|说明型旁白视为无效/);
    assert.match(template, /min\(片段秒数×2, 24\)/);
    assert.match(template, /声音与(?:微)?表情采用最小可执行集/);
    assert.match(template, /音效设计/);
    assert.match(template, /配乐设计/);
    assert.match(template, /静音\/留白|静音或声音桥/);
    assert.doesNotMatch(template, /角色闭嘴/);
    assert.match(template, /MiniMax H3/);
    assert.match(template, /subject_definitions/);
    assert.match(template, /integrated_multimodal_description/);
  });
}
