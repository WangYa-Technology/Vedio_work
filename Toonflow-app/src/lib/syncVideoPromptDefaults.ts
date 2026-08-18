import type { Knex } from "knex";
import {
  DEFAULT_VIDEO_PROMPT_ACTION,
  DEFAULT_VIDEO_PROMPT_FAITHFUL,
} from "@/constants/videoPromptDefaults";

/** Keep the two bundled defaults current without touching user-created templates. */
export async function syncVideoPromptDefaults(knex: Knex) {
  const defaults = [
    {
      id: 1786742295618,
      name: "忠实分镜型",
      content: DEFAULT_VIDEO_PROMPT_FAITHFUL,
    },
    {
      id: 1786742322711,
      name: "动作简化型",
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
