import { tool, Tool } from "ai";
import u from "@/utils";
import { z } from "zod";
import ResTool from "@/socket/resTool";

export const ShotSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  scriptId: z.number(),
  episodeNumber: z.number(),
  shotNumber: z.number(),
  content: z.string(),
  cameraMovement: z.string(),
  scale: z.string(),
  narrativePurpose: z.string(),
  duration: z.number(),
  dialogue: z.string(),
  sound: z.string(),
  platformMode: z.enum(["seedance", "jurilü", "generic"]),
  createTime: z.number(),
  updateTime: z.number(),
});

export const CharacterBibleSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  coreTheme: z.string(),
  characters: z.string(),
  wantNeedArc: z.string(),
  visualMotifs: z.string(),
  storyStructure: z.string(),
  createTime: z.number(),
  updateTime: z.number(),
});

export const DirectorAlignmentSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  emotion: z.string(),
  genre: z.string(),
  action: z.string(),
  subject: z.string(),
  form: z.string(),
  socialPerspective: z.string(),
  colorPlan: z.string(),
  soundDesign: z.string(),
  createTime: z.number(),
  updateTime: z.number(),
});

export const AssetPromptSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  series: z.enum(["C", "S", "P"]),
  assetNumber: z.string(),
  assetName: z.string(),
  platform: z.string(),
  prompt: z.string(),
  antiDistortion: z.string(),
  createTime: z.number(),
  updateTime: z.number(),
});

interface ToolConfig {
  resTool: ResTool;
  toolsNames?: string[];
  msg: ReturnType<ResTool["newMessage"]>;
}

export default (toolConfig: ToolConfig) => {
  const { resTool, toolsNames, msg } = toolConfig;
  const { socket } = resTool;

  const tools: Record<string, Tool> = {
    get_script_content: tool({
      description: "获取剧本内容",
      inputSchema: z.object({
        ids: z.array(z.string()).describe("脚本id列表"),
      }),
      execute: async ({ ids }) => {
        const thinking = msg.thinking("正在获取剧本内容...");
        const data = await u.db("o_script").whereIn("id", ids).select("content", "name");
        const text = data && data.length
          ? data.map((d: any) => `<scriptItem name="${d.name}">${d.content}</scriptItem>`).join("\n")
          : "";
        thinking.appendText("获取到剧本内容:\n" + text.slice(0, 500));
        thinking.updateTitle("获取剧本内容完成");
        thinking.complete();
        return text ?? "无数据";
      },
    }),

    get_storyboard_data: tool({
      description: "获取当前项目的分镜数据（shots、character bible、director alignment、asset prompts）",
      inputSchema: z.object({}),
      execute: async () => {
        const thinking = msg.thinking("正在获取分镜数据...");
        const projectId = resTool.data.projectId;
        const shots = await u.db("o_storyboard_shot").where({ projectId }).orderBy("episodeNumber").orderBy("shotNumber");
        const characterBible = await u.db("o_character_bible").where({ projectId }).first();
        const directorAlignment = await u.db("o_director_alignment").where({ projectId }).first();
        const assetPrompts = await u.db("o_asset_prompt").where({ projectId });
        thinking.updateTitle("获取分镜数据完成");
        thinking.complete();
        return JSON.stringify({ shots, characterBible, directorAlignment, assetPrompts });
      },
    }),

    get_workbench_data: tool({
      description: "获取工作区数据",
      inputSchema: z.object({}),
      execute: async () => {
        const thinking = msg.thinking("正在获取工作区数据...");
        const projectId = resTool.data.projectId;
        const row = await u.db("o_agentWorkData").where({ projectId, key: "storyboardAgent" }).first();
        const data = row ? JSON.parse(row.data ?? "{}") : {};
        thinking.appendText("工作区数据: " + JSON.stringify(data).slice(0, 200));
        thinking.updateTitle("获取工作区数据完成");
        thinking.complete();
        return JSON.stringify(data);
      },
    }),

    save_character_bible: tool({
      description: "保存角色圣经（Character Bible）到数据库",
      inputSchema: z.object({
        coreTheme: z.string().describe("核心梗，2-4字"),
        characters: z.string().describe("角色列表，JSON字符串"),
        wantNeedArc: z.string().describe("Want/Need/Arc三元结构"),
        visualMotifs: z.string().describe("视觉母题"),
        storyStructure: z.string().describe("大纲结构"),
      }),
      execute: async ({ coreTheme, characters, wantNeedArc, visualMotifs, storyStructure }) => {
        const thinking = msg.thinking("正在保存角色圣经...");
        const projectId = resTool.data.projectId;
        const now = Date.now();
        const existing = await u.db("o_character_bible").where({ projectId }).first();
        if (existing) {
          await u.db("o_character_bible").where({ projectId }).update({ coreTheme, characters, wantNeedArc, visualMotifs, storyStructure, updateTime: now });
        } else {
          await u.db("o_character_bible").insert({ projectId, coreTheme, characters, wantNeedArc, visualMotifs, storyStructure, createTime: now, updateTime: now });
        }
        socket.emit("storyboard:characterBibleUpdated", { projectId });
        thinking.updateTitle("角色圣经保存完成");
        thinking.complete();
        return "角色圣经保存成功";
      },
    }),

    save_director_alignment: tool({
      description: "保存导演定调数据到数据库",
      inputSchema: z.object({
        emotion: z.string().describe("情绪维度"),
        genre: z.string().describe("类型维度"),
        action: z.string().describe("动作维度"),
        subject: z.string().describe("题材维度"),
        form: z.string().describe("形式维度"),
        socialPerspective: z.string().describe("社会视角维度"),
        colorPlan: z.string().describe("色彩情绪规划"),
        soundDesign: z.string().describe("音响设计定调"),
      }),
      execute: async ({ emotion, genre, action, subject, form, socialPerspective, colorPlan, soundDesign }) => {
        const thinking = msg.thinking("正在保存导演定调...");
        const projectId = resTool.data.projectId;
        const now = Date.now();
        const existing = await u.db("o_director_alignment").where({ projectId }).first();
        if (existing) {
          await u.db("o_director_alignment").where({ projectId }).update({ emotion, genre, action, subject, form, socialPerspective, colorPlan, soundDesign, updateTime: now });
        } else {
          await u.db("o_director_alignment").insert({ projectId, emotion, genre, action, subject, form, socialPerspective, colorPlan, soundDesign, createTime: now, updateTime: now });
        }
        socket.emit("storyboard:directorAlignmentUpdated", { projectId });
        thinking.updateTitle("导演定调保存完成");
        thinking.complete();
        return "导演定调保存成功";
      },
    }),

    add_storyboard_shot: tool({
      description: "添加单个分镜到数据库",
      inputSchema: z.object({
        scriptId: z.number().describe("剧本ID"),
        episodeNumber: z.number().describe("集数"),
        shotNumber: z.number().describe("镜号"),
        content: z.string().describe("△格式分镜内容"),
        cameraMovement: z.string().describe("运镜方式"),
        scale: z.string().describe("景别"),
        narrativePurpose: z.string().describe("叙事目的"),
        duration: z.number().describe("时长（秒）"),
        dialogue: z.string().describe("台词，无则为空"),
        sound: z.string().describe("声音设计"),
        platformMode: z.enum(["seedance", "jurilü", "generic"]).describe("平台模式"),
      }),
      execute: async (shot) => {
        const thinking = msg.thinking(`正在添加第${shot.episodeNumber}集第${shot.shotNumber}镜...`);
        const projectId = resTool.data.projectId;
        const now = Date.now();
        const [id] = await u.db("o_storyboard_shot").insert({ ...shot, projectId, createTime: now, updateTime: now });
        socket.emit("storyboard:shotAdded", { id, projectId });
        thinking.updateTitle("分镜添加完成");
        thinking.complete();
        return `分镜已保存，id=${id}`;
      },
    }),

    batch_add_shots: tool({
      description: "批量添加多个分镜到数据库",
      inputSchema: z.object({
        shots: z.array(z.object({
          scriptId: z.number(),
          episodeNumber: z.number(),
          shotNumber: z.number(),
          content: z.string(),
          cameraMovement: z.string(),
          scale: z.string(),
          narrativePurpose: z.string(),
          duration: z.number(),
          dialogue: z.string(),
          sound: z.string(),
          platformMode: z.enum(["seedance", "jurilü", "generic"]),
        })).describe("分镜列表"),
      }),
      execute: async ({ shots }) => {
        const thinking = msg.thinking(`正在批量添加${shots.length}个分镜...`);
        const projectId = resTool.data.projectId;
        const now = Date.now();
        for (const shot of shots) {
          await u.db("o_storyboard_shot").insert({ ...shot, projectId, createTime: now, updateTime: now });
        }
        socket.emit("storyboard:shotsUpdated", { projectId });
        thinking.updateTitle(`批量添加${shots.length}个分镜完成`);
        thinking.complete();
        return `成功批量添加${shots.length}个分镜`;
      },
    }),

    update_shot: tool({
      description: "更新已有分镜",
      inputSchema: z.object({
        id: z.number().describe("分镜ID"),
        content: z.string().optional(),
        cameraMovement: z.string().optional(),
        scale: z.string().optional(),
        narrativePurpose: z.string().optional(),
        duration: z.number().optional(),
        dialogue: z.string().optional(),
        sound: z.string().optional(),
        platformMode: z.enum(["seedance", "jurilü", "generic"]).optional(),
      }),
      execute: async ({ id, ...updates }) => {
        const thinking = msg.thinking(`正在更新分镜 id=${id}...`);
        const projectId = resTool.data.projectId;
        await u.db("o_storyboard_shot").where({ id, projectId }).update({ ...updates, updateTime: Date.now() });
        socket.emit("storyboard:shotsUpdated", { projectId });
        thinking.updateTitle("分镜更新完成");
        thinking.complete();
        return `分镜 id=${id} 更新成功`;
      },
    }),

    delete_shot: tool({
      description: "删除分镜",
      inputSchema: z.object({
        id: z.number().describe("分镜ID"),
      }),
      execute: async ({ id }) => {
        const thinking = msg.thinking(`正在删除分镜 id=${id}...`);
        const projectId = resTool.data.projectId;
        await u.db("o_storyboard_shot").where({ id, projectId }).delete();
        socket.emit("storyboard:shotsUpdated", { projectId });
        thinking.updateTitle("分镜删除完成");
        thinking.complete();
        return `分镜 id=${id} 已删除`;
      },
    }),

    set_platform_mode: tool({
      description: "批量设置分镜的平台模式（seedance首尾帧 / jurilü融生视频 / generic通用）",
      inputSchema: z.object({
        platformMode: z.enum(["seedance", "jurilü", "generic"]).describe("平台模式"),
        episodeNumber: z.number().optional().describe("只更新指定集数，不传则更新所有"),
      }),
      execute: async ({ platformMode, episodeNumber }) => {
        const thinking = msg.thinking(`正在设置平台模式为 ${platformMode}...`);
        const projectId = resTool.data.projectId;
        const query = u.db("o_storyboard_shot").where({ projectId });
        if (episodeNumber !== undefined) query.where({ episodeNumber });
        await query.update({ platformMode, updateTime: Date.now() });
        socket.emit("storyboard:shotsUpdated", { projectId });
        thinking.updateTitle("平台模式设置完成");
        thinking.complete();
        return `平台模式已设置为 ${platformMode}`;
      },
    }),

    save_asset_prompt: tool({
      description: "保存资产提示词（角色/场景/道具）",
      inputSchema: z.object({
        series: z.enum(["C", "S", "P"]).describe("资产类型：C角色/S场景/P道具"),
        assetNumber: z.string().describe("资产编号，如C01、S01"),
        assetName: z.string().describe("资产名称"),
        platform: z.string().describe("目标平台"),
        prompt: z.string().describe("AI生成提示词"),
        antiDistortion: z.string().describe("防崩约束"),
      }),
      execute: async ({ series, assetNumber, assetName, platform, prompt, antiDistortion }) => {
        const thinking = msg.thinking(`正在保存资产提示词 ${assetNumber}...`);
        const projectId = resTool.data.projectId;
        const now = Date.now();
        const existing = await u.db("o_asset_prompt").where({ projectId, assetNumber }).first();
        if (existing) {
          await u.db("o_asset_prompt").where({ projectId, assetNumber }).update({ series, assetName, platform, prompt, antiDistortion, updateTime: now });
        } else {
          await u.db("o_asset_prompt").insert({ projectId, series, assetNumber, assetName, platform, prompt, antiDistortion, createTime: now, updateTime: now });
        }
        socket.emit("storyboard:assetPromptsUpdated", { projectId });
        thinking.updateTitle(`资产提示词 ${assetNumber} 保存完成`);
        thinking.complete();
        return `资产提示词 ${assetNumber} 保存成功`;
      },
    }),
  };

  return toolsNames ? Object.fromEntries(Object.entries(tools).filter(([n]) => toolsNames.includes(n))) : tools;
};
