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
    assert.match(template, /全程禁止背景音乐、配乐(?:、|和)\s*BGM/);
    assert.match(template, /non_diegetic_music (?:必须且只能写|固定为) N\/A/);
    assert.match(template, /全程禁止字幕/);
    assert.match(template, /中景或中远景/);
    assert.match(template, /面部.*锐利对焦/);
    assert.doesNotMatch(template, /角色闭嘴/);
    assert.match(template, /MiniMax H3/);
    assert.match(template, /subject_definitions/);
    assert.match(template, /integrated_multimodal_description/);
    assert.match(template, /【参考素材说明】/);
    assert.match(template, /【核心创意】/);
    assert.match(template, /【画面过程描述】/);
    assert.match(template, /【不想要】/);
    assert.match(template, /@图片1、@视频1、@音频1/);
    assert.match(template, /用途、锁定维度和不参考维度/);
    assert.match(template, /Shot N（起始秒-结束秒）/);
    assert.match(template, /中文台词字数÷3/);
    assert.match(template, /人物远景镜头/);
    assert.match(template, /truck left \+ pan right/);
    assert.match(template, /非叙事性音乐：N\/A/);
    assert.match(template, /说明正文、镜头、动作、声音、旁白和对白全部写中文/);
    assert.match(template, /视频复盘得到的节奏硬约束/);
    assert.match(template, /0-1\.5 秒/);
    assert.match(template, /近景\/特写.*片段三分之一/);
    assert.match(template, /单镜头.*不得伪造切镜/);
  });
}
