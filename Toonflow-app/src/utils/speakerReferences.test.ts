import assert from "node:assert/strict";
import test from "node:test";
import {
  collectMissingSpeakerEntries,
  missingSpeakerReferences,
  normalizeShots,
} from "./speakerReferences";

test("treats an exactly bound role name as referenced", () => {
  const task = {
    id: 11,
    segmentRows: [
      { dialogue: "陈照野：你来了。", description: "陈照野推门而入", duration: 3 },
    ],
    medias: [{ name: "陈照野", type: "role" }],
  };
  assert.deepEqual(missingSpeakerReferences(task), []);
});

test("normalizes narrative verbs in speaker names", () => {
  const task = {
    id: 12,
    segmentRows: [{ dialogue: "老王问：吃了吗？", description: "", duration: 2 }],
    medias: [{ name: "老王", type: "role" }],
  };
  assert.deepEqual(missingSpeakerReferences(task), []);
});

test("reports speakers without an independent role reference", () => {
  const task = {
    id: 13,
    segmentRows: [
      { dialogue: "销售：您好，请问几位？", description: "", duration: 2 },
    ],
    medias: [{ name: "陈照野", type: "role" }],
  };
  assert.deepEqual(missingSpeakerReferences(task), ["销售"]);
});

test("ignores non-role media when matching speaker references", () => {
  const task = {
    id: 14,
    segmentRows: [{ dialogue: "销售：您好。", description: "", duration: 2 }],
    medias: [{ name: "销售", type: "scene" }],
  };
  assert.deepEqual(missingSpeakerReferences(task), ["销售"]);
});

test("checks every speaker when a shot contains multiple dialogue lines", () => {
  const task = {
    id: 15,
    segmentRows: [
      { dialogue: "销售：您好。<br>陈照野：一位。", description: "", duration: 4 },
    ],
    medias: [{ name: "陈照野", type: "role" }],
  };
  assert.deepEqual(missingSpeakerReferences(task), ["销售"]);
});

test("collects structured missing speaker entries", () => {
  const tasks = [
    {
      id: 101,
      storyboardIds: [201, 202],
      sceneTitle: "咖啡店",
      segmentTitle: "片段三",
      segmentRows: [
        { dialogue: "销售：您好。", description: "", duration: 2 },
        { dialogue: "陈照野：一位。", description: "", duration: 2 },
      ],
      medias: [{ name: "陈照野", type: "role" }],
    },
  ];
  assert.deepEqual(collectMissingSpeakerEntries(tasks), [
    {
      trackId: 101,
      storyboardIds: [201, 202],
      sceneTitle: "咖啡店",
      segmentTitle: "片段三",
      speakerName: "销售",
    },
  ]);
});

test("returns an empty list when every speaker has a reference", () => {
  const tasks = [
    {
      id: 102,
      storyboardIds: [301],
      sceneTitle: "咖啡店",
      segmentTitle: "片段四",
      segmentRows: [{ dialogue: "陈照野：一位。", description: "", duration: 2 }],
      medias: [{ name: "陈照野", type: "role" }],
    },
  ];
  assert.deepEqual(collectMissingSpeakerEntries(tasks), []);
});

test("treats VO text-source labels as in-frame text instead of speakers", () => {
  const rows = [
    {
      dialogue: "VO（摊车灯牌文字）：『照野炸串』",
      description: "灯牌亮起",
      duration: 3,
      sound: "环境音：汤锅咕嘟声",
    },
    {
      dialogue: "VO（刘鹏消息文字）：『你先别激动。』",
      description: "消息逐字弹出",
      duration: 2.5,
      sound: "",
    },
    {
      dialogue: "（VO）银行流水文字：『收款人：许曼青。材料费。』",
      description: "流水弹出",
      duration: 3,
      sound: "",
    },
    {
      dialogue: "VO（转账截图备注栏文字）：『备注栏：材料款、培训费、设备定金。』",
      description: "备注栏弹出",
      duration: 2,
      sound: "",
    },
  ];
  const task = {
    id: 21,
    segmentRows: rows,
    medias: [
      { name: "陈照野", type: "role" },
      { name: "许曼青", type: "role" },
    ],
  };
  assert.deepEqual(missingSpeakerReferences(task), []);

  const shots = normalizeShots(rows);
  assert.deepEqual(
    shots.map((shot) => shot.onScreenText),
    [
      "照野炸串",
      "你先别激动。",
      "收款人：许曼青。材料费。",
      "备注栏：材料款、培训费、设备定金。",
    ],
  );
  assert.ok(
    shots.every(
      (shot) =>
        shot.dialogue === "无台词" &&
        shot.speechAllowed === false &&
        shot.dialogueType === "none" &&
        shot.speakerNames.length === 0,
    ),
  );
});

test("treats OS/VO interface sources without the 文字 suffix as in-frame text", () => {
  const rows = [
    { dialogue: "VO（手机来电显示）：『许曼青』", description: "来电", duration: 2, sound: "" },
  ];
  const task = { id: 22, segmentRows: rows, medias: [{ name: "陈照野", type: "role" }] };
  assert.deepEqual(missingSpeakerReferences(task), []);
  assert.equal(normalizeShots(rows)[0].onScreenText, "许曼青");
});

test("treats narration and sound sources as voiceless labels", () => {
  const rows = [
    { dialogue: "VO（旁白）：『退路正在消失。』", description: "空镜", duration: 2, sound: "" },
    { dialogue: "OS（内心独白）：『我不能再等了。』", description: "内心", duration: 2, sound: "" },
    { dialogue: "VO（广播）：『夜市十点收摊。』", description: "广播", duration: 2, sound: "" },
    { dialogue: "VO（心跳声）：『咚、咚。』", description: "心跳", duration: 1.5, sound: "" },
    { dialogue: "短信：『你先别激动。』", description: "短信", duration: 2, sound: "" },
  ];
  const task = { id: 24, segmentRows: rows, medias: [] };
  // 朗读/播报/音效来源不是角色：不应要求独立角色参考
  assert.deepEqual(missingSpeakerReferences(task), []);

  const shots = normalizeShots(rows);
  // 旁白与内心独白仍作为发声台词保留（画外旁白），只是不绑定角色
  assert.deepEqual(shots[0].speakerNames, []);
  assert.equal(shots[0].dialogueType, "voiceover_vo");
  assert.equal(shots[0].actualDialogue, "退路正在消失。");
  assert.equal(shots[0].speechAllowed, true);
  assert.equal(shots[0].onScreenText, "");
  assert.deepEqual(shots[1].speakerNames, []);
  assert.equal(shots[1].dialogueType, "inner_monologue_os");
  assert.equal(shots[1].actualDialogue, "我不能再等了。");
  assert.deepEqual(shots[2].speakerNames, []);
  assert.deepEqual(shots[3].speakerNames, []);
  assert.equal(shots[3].speechAllowed, true);
  // 裸写的屏幕来源按画内文字处理（不发声、不需要参考）
  assert.equal(shots[4].dialogue, "无台词");
  assert.equal(shots[4].onScreenText, "你先别激动。");
  assert.equal(shots[4].speechAllowed, false);
});

test("keeps spoken voiceover lines and mixed rows as dialogue", () => {
  const rows = [
    { dialogue: "VO（陈照野）：『别出声。』", description: "门外动静", duration: 2, sound: "" },
    {
      dialogue: "陈照野说：『马上！』<br>VO（摊车灯牌文字）：『照野炸串』",
      description: "剁串",
      duration: 4,
      sound: "",
    },
    { dialogue: "老王：手机不见了", description: "找不到手机", duration: 2, sound: "" },
  ];
  const task = {
    id: 23,
    segmentRows: rows,
    medias: [{ name: "陈照野", type: "role" }],
  };
  // "VO（陈照野）"与"老王：手机不见了"仍按说话人解析；只有真正的来源标签才转成画内文字。
  assert.deepEqual(missingSpeakerReferences(task), ["老王"]);

  const shots = normalizeShots(rows);
  assert.deepEqual(shots[0].speakerNames, ["陈照野"]);
  assert.equal(shots[0].onScreenText, "");
  // 多句混写：画内文字段被剔除并保留在画内文字里，其余台词仍参与说话人解析。
  assert.equal(shots[1].dialogue, "陈照野说：『马上！』");
  assert.deepEqual(shots[1].speakerNames, ["陈照野"]);
  assert.equal(shots[1].onScreenText, "照野炸串");
  assert.deepEqual(shots[2].speakerNames, ["老王"]);
  assert.equal(shots[2].onScreenText, "");
});

test("normalizes shots with cumulative timing and on-screen text", () => {
  const shots = normalizeShots([
    {
      serial: "1",
      dialogue: "无台词",
      description: "开场",
      duration: 2,
      sound: "音效：雨声",
    },
    {
      serial: "2",
      dialogue: "屏幕文字：营业中",
      description: "特写",
      duration: 3,
      sound: "",
    },
    {
      serial: "3",
      dialogue: "销售：欢迎光临。",
      description: "迎客",
      duration: 4,
      sound: "",
    },
  ]);
  assert.equal(shots[0].h3CutTimestamp, "opening shot - no timestamp");
  assert.equal(shots[0].sound, "雨声");
  assert.equal(shots[1].startSeconds, 2);
  assert.equal(shots[1].dialogue, "无台词");
  assert.equal(shots[1].onScreenText, "营业中");
  assert.equal(shots[1].speechAllowed, false);
  assert.equal(shots[1].h3CutTimestamp, "At 00:02.000");
  assert.equal(shots[2].endSeconds, 9);
  assert.deepEqual(shots[2].speakerNames, ["销售"]);
  assert.equal(shots[2].sound, "无音效");
});
