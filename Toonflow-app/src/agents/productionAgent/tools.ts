import { tool, type Tool } from "ai";
import { z } from "zod";
import u from "@/utils";
import ResTool from "@/socket/resTool";
import { buildProductionFlowData } from "@/utils/productionFlow";
import { queueAssetImagesById, queueStoryboardImages } from "@/services/imageGeneration";

interface ToolConfig {
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  toolsNames?: string[];
}

const flowDataKeys = z.enum(["script", "scriptPlan", "assets", "storyboardTable", "storyboard"]);
const flowDataLabels: Record<z.infer<typeof flowDataKeys>, string> = {
  script: "剧本",
  scriptPlan: "导演规划",
  assets: "资产",
  storyboardTable: "分镜表",
  storyboard: "分镜面板",
};

function normalizeIds(ids: number[] | null | undefined) {
  return [...new Set((ids || []).map(Number).filter(Number.isFinite))];
}

export default ({ resTool, msg, toolsNames }: ToolConfig) => {
  const { socket } = resTool;
  const projectId = Number(resTool.data.projectId);
  const scriptId = Number(resTool.data.scriptId);

  const ensureContext = () => {
    if (!Number.isFinite(projectId) || !Number.isFinite(scriptId)) throw new Error("生产 Agent 缺少项目或剧本上下文");
  };

  const generateAssetsTool = () =>
    tool({
      description: "异步生成指定资产图片",
      inputSchema: z.object({ ids: z.array(z.number()).describe("真实资产 ID 列表") }),
      execute: async ({ ids }) => {
        ensureContext();
        const normalized = normalizeIds(ids);
        if (!normalized.length) throw new Error("没有可提交的资产 ID");
        const thinking = msg.thinking("正在提交资产图片生成...");
        try {
          const result = await queueAssetImagesById(projectId, normalized);
          socket.emit("flowDataUpdated", { reason: "assetImagesQueued", assetIds: normalized });
          thinking.appendText(JSON.stringify(result, null, 2));
          thinking.updateTitle("资产图片生成任务已提交");
          thinking.complete();
          return result;
        } catch (error) {
          const message = u.error(error).message;
          thinking.appendText(message);
          thinking.updateTitle("资产图片生成提交失败");
          thinking.complete();
          throw error;
        }
      },
    });

  const generateStoryboardTool = () =>
    tool({
      description: "异步生成指定分镜图片",
      inputSchema: z.object({ ids: z.array(z.number()).describe("真实分镜 ID 列表") }),
      execute: async ({ ids }) => {
        ensureContext();
        const normalized = normalizeIds(ids);
        if (!normalized.length) throw new Error("没有可提交的分镜 ID");
        const thinking = msg.thinking("正在提交分镜图片生成...");
        try {
          const result = await queueStoryboardImages({
            projectId,
            scriptId,
            storyboardIds: normalized,
          });
          socket.emit("flowDataUpdated", { reason: "storyboardImagesQueued", storyboardIds: result.queuedIds });
          thinking.appendText(JSON.stringify(result, null, 2));
          thinking.updateTitle("分镜图片生成任务已提交");
          thinking.complete();
          return result;
        } catch (error) {
          const message = u.error(error).message;
          thinking.appendText(message);
          thinking.updateTitle("分镜图片生成提交失败");
          thinking.complete();
          throw error;
        }
      },
    });

  const tools: Record<string, Tool> = {
    get_flowData: tool({
      description: "读取当前剧本的正式生产工作区数据",
      inputSchema: z.object({ key: flowDataKeys.describe("工作区数据类型") }),
      execute: async ({ key }) => {
        ensureContext();
        const thinking = msg.thinking(`正在获取${flowDataLabels[key]}...`);
        const flowData = await buildProductionFlowData(projectId, scriptId);
        thinking.updateTitle(`获取${flowDataLabels[key]}完成`);
        thinking.complete();
        return flowData[key] ?? null;
      },
    }),

    add_deriveAsset: tool({
      description: "新增或更新衍生资产",
      inputSchema: z.object({
        assetsId: z.number().describe("父资产真实 ID"),
        id: z.number().nullable().describe("更新时填写衍生资产真实 ID，新增时为 null"),
        name: z.string(),
        desc: z.string(),
      }),
      execute: async ({ assetsId, id, name, desc }) => {
        ensureContext();
        const thinking = msg.thinking("正在写入衍生资产...");
        const parent = await u.db("o_assets").where({ id: assetsId, projectId }).first();
        if (!parent) throw new Error(`父资产不存在：${assetsId}`);
        const data = {
          assetsId,
          projectId,
          name,
          type: parent.type,
          describe: desc,
          startTime: Date.now(),
        };
        let assetId = id;
        if (assetId != null) {
          const updated = await u.db("o_assets").where({ id: assetId, projectId }).update(data);
          if (!updated) throw new Error(`衍生资产不存在：${assetId}`);
        } else {
          const inserted = await u.db("o_assets").insert(data);
          assetId = Number(inserted[0]);
          await u.db("o_scriptAssets").insert({ scriptId, assetId }).onConflict(["scriptId", "assetId"]).ignore();
        }
        socket.emit("flowDataUpdated", { reason: "deriveAsset", assetId });
        thinking.updateTitle("衍生资产写入完成");
        thinking.complete();
        return { success: true, assetId };
      },
    }),

    del_deriveAsset: tool({
      description: "删除指定衍生资产",
      inputSchema: z.object({ assetsId: z.number(), id: z.number() }),
      execute: async ({ id }) => {
        ensureContext();
        const thinking = msg.thinking("正在删除衍生资产...");
        await u.db("o_scriptAssets").where({ scriptId, assetId: id }).del();
        const deleted = await u.db("o_assets").where({ id, projectId }).del();
        if (!deleted) throw new Error(`衍生资产不存在：${id}`);
        socket.emit("flowDataUpdated", { reason: "deriveAssetDeleted", assetId: id });
        thinking.updateTitle("衍生资产删除完成");
        thinking.complete();
        return { success: true, assetId: id };
      },
    }),

    generate_deriveAsset: generateAssetsTool(),
    generate_assets_images: generateAssetsTool(),
    generate_storyboard: generateStoryboardTool(),
    generate_storyboard_images: generateStoryboardTool(),

    add_flowData_storyboard: tool({
      description: "向正式分镜面板逐条新增一个写入单位",
      inputSchema: z.object({
        videoDesc: z.string().describe("完整视频描述"),
        prompt: z.string().nullable().describe("分镜图片提示词；纯文本多参模式可为空"),
        track: z.string().describe("分组名称"),
        duration: z.number().positive().describe("时长，秒"),
        associateAssetsIds: z.array(z.number()).nullable().describe("关联资产真实 ID 列表"),
        shouldGenerateImage: z.union([z.boolean(), z.enum(["true", "false"])]),
      }),
      execute: async (raw) => {
        ensureContext();
        const thinking = msg.thinking("正在写入正式分镜面板...");
        const assets = normalizeIds(raw.associateAssetsIds);
        const existingAssets = assets.length
          ? await u.db("o_assets").where({ projectId }).whereIn("id", assets).pluck("id")
          : [];
        if (existingAssets.length !== assets.length) {
          const existing = new Set(existingAssets.map(Number));
          throw new Error(`关联资产不存在：${assets.filter((id) => !existing.has(id)).join(", ")}`);
        }
        const maxIndex = await u.db("o_storyboard").where({ projectId, scriptId }).max("index as value").first();
        const index = Number((maxIndex as any)?.value ?? -1) + 1;
        const shouldGenerateImage = raw.shouldGenerateImage === true || raw.shouldGenerateImage === "true" ? 1 : 0;
        const inserted = await u.db("o_storyboard").insert({
          projectId,
          scriptId,
          prompt: raw.prompt || "",
          filePath: null,
          duration: String(raw.duration),
          state: "未生成",
          trackId: Date.now() * 100 + index,
          reason: "",
          track: raw.track,
          videoDesc: raw.videoDesc,
          shouldGenerateImage,
          flowId: null,
          index,
          createTime: Date.now(),
        });
        const storyboardId = Number(inserted[0]);
        if (assets.length) {
          await u.db("o_assets2Storyboard").insert(assets.map((assetId) => ({ storyboardId, assetId })));
        }
        socket.emit("flowDataUpdated", { reason: "storyboardAdded", storyboardId });
        thinking.appendText(`真实分镜 ID：${storyboardId}`);
        thinking.updateTitle("正式分镜面板写入完成");
        thinking.complete();
        return { success: true, storyboardId, index, associateAssetsIds: assets };
      },
    }),

    get_storyboard_asset_binding: tool({
      description: "按正式分镜面板顺序查询真实分镜 ID、提示词和资产绑定",
      inputSchema: z.object({ storyboardIndex: z.number().int().nonnegative() }),
      execute: async ({ storyboardIndex }) => {
        ensureContext();
        const rows = await u.db("o_storyboard").where({ projectId, scriptId }).orderByRaw('COALESCE("index", 2147483647), id');
        const row = rows[storyboardIndex];
        if (!row) throw new Error(`分镜面板不存在第 ${storyboardIndex + 1} 项`);
        const associateAssetsIds = (await u.db("o_assets2Storyboard").where({ storyboardId: row.id }).pluck("assetId")).map(Number);
        return {
          storyboardId: Number(row.id),
          index: row.index == null ? null : Number(row.index),
          flowId: row.flowId == null ? null : Number(row.flowId),
          prompt: row.prompt || "",
          videoDesc: row.videoDesc || "",
          associateAssetsIds,
        };
      },
    }),

    update_storyboard_asset_binding: tool({
      description: "使用真实分镜 ID 替换已有分镜的资产绑定，不新增分镜",
      inputSchema: z.object({
        storyboardIndex: z.number().int().nonnegative().optional(),
        expectedStoryboardId: z.number().int().positive(),
        associateAssetsIds: z.array(z.number()),
      }),
      execute: async ({ storyboardIndex, expectedStoryboardId, associateAssetsIds }) => {
        ensureContext();
        const row = await u.db("o_storyboard").where({ id: expectedStoryboardId, projectId, scriptId }).first();
        if (!row) throw new Error(`真实分镜不存在：${expectedStoryboardId}`);
        if (storyboardIndex != null) {
          const ordered = await u.db("o_storyboard").where({ projectId, scriptId }).orderByRaw('COALESCE("index", 2147483647), id');
          if (Number(ordered[storyboardIndex]?.id) !== expectedStoryboardId) throw new Error("分镜序号与真实 ID 不一致，已阻止更新");
        }
        const assets = normalizeIds(associateAssetsIds);
        const assetRows = assets.length ? await u.db("o_assets").where({ projectId }).whereIn("id", assets).pluck("id") : [];
        if (assetRows.length !== assets.length) throw new Error("目标资产列表包含不存在的资产 ID");
        await u.db.transaction(async (trx) => {
          await trx("o_assets2Storyboard").where({ storyboardId: expectedStoryboardId }).del();
          if (assets.length) await trx("o_assets2Storyboard").insert(assets.map((assetId) => ({ storyboardId: expectedStoryboardId, assetId })));
        });
        const verified = (await u.db("o_assets2Storyboard").where({ storyboardId: expectedStoryboardId }).pluck("assetId")).map(Number);
        socket.emit("updateStoryboardAssetBinding", { storyboardId: expectedStoryboardId, associateAssetsIds: verified });
        socket.emit("flowDataUpdated", { reason: "storyboardBinding", storyboardId: expectedStoryboardId });
        return { success: true, verified: JSON.stringify(verified) === JSON.stringify(assets), storyboardId: expectedStoryboardId, associateAssetsIds: verified };
      },
    }),

    update_storyboard_prompt: tool({
      description: "使用真实分镜 ID 定点更新已有分镜提示词，不新增分镜、不触发生成",
      inputSchema: z.object({
        storyboardId: z.number().int().positive(),
        prompt: z.string().min(1),
        videoDesc: z.string().optional(),
      }),
      execute: async ({ storyboardId, prompt, videoDesc }) => {
        ensureContext();
        const patch: Record<string, string> = { prompt };
        if (videoDesc !== undefined) patch.videoDesc = videoDesc;
        const updated = await u.db("o_storyboard").where({ id: storyboardId, projectId, scriptId }).update(patch);
        if (!updated) throw new Error(`真实分镜不存在：${storyboardId}`);
        socket.emit("updateStoryboardPrompt", { storyboardId, prompt, videoDesc });
        socket.emit("flowDataUpdated", { reason: "storyboardPrompt", storyboardId });
        return { success: true, storyboardId, prompt };
      },
    }),
  };

  return toolsNames ? Object.fromEntries(Object.entries(tools).filter(([name]) => toolsNames.includes(name))) : tools;
};
