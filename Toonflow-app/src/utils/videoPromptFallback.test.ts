import assert from "node:assert/strict";
import test from "node:test";
import { buildChineseVideoPromptFallback } from "./videoPromptFallback";
import { collectVideoPromptContractViolations } from "./videoPromptContract";

test("fallback serializes facts as a Chinese high-conflict prompt", () => {
  const prompt = buildChineseVideoPromptFallback(
    {
      duration: 8,
      requiresNarrativeVoiceover: true,
      medias: [
        { name: "王胜", type: "role" },
        { name: "降落伞", type: "props" },
      ],
      segmentRows: [
        {
          serial: "1",
          description: "降落伞骤然塌陷，王胜开始下坠",
          duration: 3,
          scale: "中远景",
          cameraMovement: "俯拍跟随",
          dialogue: "无台词",
          sound: "高空风声",
        },
      ],
    },
    { referenceToken: "@图", videoRatio: "16:9", artStyle: "半写实3D动漫" },
  );

  assert.match(prompt, /<Subject 1> 是来自 @图1/);
  assert.match(prompt, /王牌狙击手，却失去降落伞/);
  assert.match(prompt, /降落伞骤然塌陷/);
  assert.match(prompt, /全程无字幕/);
  assert.match(prompt, /面部保持锐利对焦/);
  assert.match(prompt, /non_diegetic_music:\nN\/A/);
  assert.doesNotMatch(prompt, /is the character|角色闭嘴/);
  assert.deepEqual(
    collectVideoPromptContractViolations(
      {
        duration: 8,
        requiresNarrativeVoiceover: true,
        segmentRows: [
          {
            description: "降落伞骤然塌陷，王胜开始下坠",
            duration: 3,
            dialogue: "无台词",
            scale: "中远景",
          },
        ],
      },
      prompt,
      {
        artStyle: "半写实3D动漫",
        videoRatio: "16:9",
        referenceToken: "@图",
        audioSupported: true,
        videoPromptProfile: { modelFamily: "generic", modeKind: "multiReference" },
      },
    ),
    [],
  );
});
