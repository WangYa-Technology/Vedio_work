import type { Knex } from "knex";
import {
  DEFAULT_VIDEO_PROMPT_ACTION,
  DEFAULT_VIDEO_PROMPT_FAITHFUL,
} from "@/constants/videoPromptDefaults";
import { DEFAULT_OFFICIAL_VIDEO_PROMPT } from "@/utils/videoPromptTemplate";

/** Keep the bundled defaults current without touching user-created templates. */
export async function syncVideoPromptDefaults(knex: Knex) {
  await knex("o_prompt")
    .where({ id: 3, type: "videoPromptGeneration" })
    // Keep the bundled template visible in settings. The resolver recognizes
    // this exact content as the official default and still appends runtime context.
    .update({
      name: "高冲突默认推理",
      data: DEFAULT_OFFICIAL_VIDEO_PROMPT,
      useData: DEFAULT_OFFICIAL_VIDEO_PROMPT,
    });

  const defaults = [
    {
      id: 1786742295618,
      name: "叙事张力型",
      content: DEFAULT_VIDEO_PROMPT_FAITHFUL,
    },
    {
      id: 1786742322711,
      name: "高冲突动作型",
      content: DEFAULT_VIDEO_PROMPT_ACTION,
    },
  ];

  for (const item of defaults) {
    await knex("o_prompt")
      .where({ id: item.id, type: "videoPromptGeneration" })
      .update({
        name: item.name,
        data: item.content,
        useData: item.content,
      });
  }
}
