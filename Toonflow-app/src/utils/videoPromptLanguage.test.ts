import assert from "node:assert/strict";
import test from "node:test";
import { isPredominantlyChineseVideoPrompt } from "./videoPromptLanguage";

test("accepts Chinese H3 body with fixed English protocol keys", () => {
  assert.equal(
    isPredominantlyChineseVideoPrompt(`subject_definitions:\n<Subject 1> 是王胜角色参考。\nsummary:\n王胜原本是王牌狙击手，却在降落伞失效后从高空失控坠向湖面。\ndetailed_description:\n[Shot 1] 0-3s，黑色伞布骤然塌陷，人物持续向下接近水面。音效：狂风和伞布撕裂声。`),
    true,
  );
});

test("rejects a stale English H3 body", () => {
  assert.equal(
    isPredominantlyChineseVideoPrompt(`subject_definitions:\n<Subject 1> is the character reference.\nsummary:\nPreserve the supplied subjects and the original shot timeline while adapting this legacy prompt to MiniMax H3 Ref2VA.\nretention_analysis:\nfully_preserved - identity and visual role retained.\ndetailed_description:\nsemi-realistic 3D anime render, the subject moves continuously downward from the upper part of the frame toward the water surface; the camera follows the descent. overall_soundscape: wind and impact sounds. non_diegetic_music: sparse pulse.`),
    false,
  );
});
