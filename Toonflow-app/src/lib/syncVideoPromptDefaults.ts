import type { Knex } from "knex";
import {
  DEFAULT_VIDEO_PROMPT_ACTION,
  DEFAULT_VIDEO_PROMPT_FAITHFUL,
} from "@/constants/videoPromptDefaults";
import { DEFAULT_OFFICIAL_VIDEO_PROMPT } from "@/utils/videoPromptTemplate";

/** Seed missing bundled defaults without overwriting templates edited in settings. */
export async function syncVideoPromptDefaults(knex: Knex) {
  const defaults = [
    {
      id: 3,
      name: "高冲突默认推理",
      content: DEFAULT_OFFICIAL_VIDEO_PROMPT,
    },
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
    const existing = await knex("o_prompt")
      .where({ id: item.id, type: "videoPromptGeneration" })
      .select("id")
      .first();
    if (existing) continue;
    await knex("o_prompt").insert({
      id: item.id,
      name: item.name,
      type: "videoPromptGeneration",
      data: item.content,
      useData: item.content,
    });
  }
}
