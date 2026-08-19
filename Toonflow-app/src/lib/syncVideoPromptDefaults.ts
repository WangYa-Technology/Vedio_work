import type { Knex } from "knex";
import {
  DEFAULT_VIDEO_PROMPT_ACTION,
  DEFAULT_VIDEO_PROMPT_FAITHFUL,
} from "@/constants/videoPromptDefaults";

/** Keep the bundled defaults current without touching user-created templates. */
export async function syncVideoPromptDefaults(knex: Knex) {
  await knex("o_prompt")
    .where({ id: 3, type: "videoPromptGeneration" })
    // ID 3 is the bundled selector shown as the default in the production
    // workbench. Keep it empty so resolveVideoPromptInstructions can inject
    // the maintained protocol instead of running the legacy seeded skill.
    .update({ name: "高冲突默认推理", data: "", useData: "" });

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
