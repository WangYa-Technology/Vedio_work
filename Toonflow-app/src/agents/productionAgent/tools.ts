import { tool, type Tool } from "ai";
import { z } from "zod";
import u from "@/utils";
import ResTool from "@/socket/resTool";
import { buildProductionFlowData, parseStoryboardTableAssetBindings } from "@/utils/productionFlow";
import {
  buildDerivedAssetPrompt,
  queueAssetImagesById,
  queueStoryboardImages,
} from "@/services/imageGeneration";

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

function sameIds(left: number[], right: number[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
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
        name: z.string().trim().min(1),
        desc: z.string().trim().min(1),
        prompt: z.string().trim().min(1).describe("可直接用于图片生成的衍生目标提示词"),
      }),
      execute: async ({ assetsId, id, name, desc, prompt }) => {
        ensureContext();
        const thinking = msg.thinking("正在写入衍生资产...");
        let assetId = id;
        let savedPrompt = "";
        await u.db.transaction(async (trx) => {
          const parent = await trx("o_assets").where({ id: assetsId, projectId }).first();
          if (!parent || parent.assetsId != null) throw new Error(`父资产不存在：${assetsId}`);
          savedPrompt = buildDerivedAssetPrompt({
            type: parent.type,
            parentName: parent.name || `资产 ${assetsId}`,
            parentDescribe: parent.describe,
            name,
            describe: desc,
            prompt,
          });
          const data = {
            assetsId,
            projectId,
            name,
            type: parent.type,
            describe: desc,
            prompt: savedPrompt,
            promptState: "已完成",
            promptErrorReason: "",
            startTime: Date.now(),
          };
          if (assetId != null) {
            const updated = await trx("o_assets").where({ id: assetId, projectId, assetsId }).update(data);
            if (!updated) throw new Error(`衍生资产不存在或不属于父资产 ${assetsId}：${assetId}`);
          } else {
            const inserted = await trx("o_assets").insert(data);
            assetId = Number(inserted[0]);
          }
          await trx("o_scriptAssets").insert({ scriptId, assetId }).onConflict(["scriptId", "assetId"]).ignore();
        });
        const saved = await u.db("o_assets").where({ id: assetId, projectId, assetsId }).first();
        const linked = await u.db("o_scriptAssets").where({ scriptId, assetId }).first();
        if (!saved || !linked || saved.name !== name || saved.describe !== desc || saved.prompt !== savedPrompt) {
          throw new Error("衍生资产写入后回读校验失败");
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
      execute: async ({ assetsId, id }) => {
        ensureContext();
        const thinking = msg.thinking("正在删除衍生资产...");
        await u.db.transaction(async (trx) => {
          const target = await trx("o_assets").where({ id, projectId, assetsId }).first();
          if (!target) throw new Error(`衍生资产不存在或不属于父资产 ${assetsId}：${id}`);
          await trx("o_scriptAssets").where({ scriptId, assetId: id }).del();
          await trx("o_assets").where({ id, projectId, assetsId }).del();
        });
        if (await u.db("o_assets").where({ id, projectId }).first()) throw new Error("衍生资产删除后回读校验失败");
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
        // An explicit empty list is authoritative for text-only video generation.
        // Only infer assets from the storyboard table when the caller leaves it unspecified.
        let assets = normalizeIds(raw.associateAssetsIds);
        const flowData = await buildProductionFlowData(projectId, scriptId);
        const tableBindings = parseStoryboardTableAssetBindings(flowData.storyboardTable || "");
        const shouldGenerateImage = raw.shouldGenerateImage === true || raw.shouldGenerateImage === "true" ? 1 : 0;
        let storyboardId = 0;
        let index = 0;
        await u.db.transaction(async (trx) => {
          const maxIndex = await trx("o_storyboard").where({ projectId, scriptId }).max("index as value").first();
          index = Number((maxIndex as any)?.value ?? -1) + 1;
          if (raw.associateAssetsIds == null && tableBindings[index]?.length) assets = tableBindings[index];
          const existingAssets = assets.length ? await trx("o_assets").where({ projectId }).whereIn("id", assets).pluck("id") : [];
          if (existingAssets.length !== assets.length) {
            const existing = new Set(existingAssets.map(Number));
            throw new Error(`关联资产不存在：${assets.filter((id) => !existing.has(id)).join(", ")}`);
          }
          const now = Date.now();
          const inserted = await trx("o_storyboard").insert({
            projectId,
            scriptId,
            prompt: raw.prompt || "",
            filePath: null,
            duration: String(raw.duration),
            state: "未生成",
            trackId: now * 100 + index,
            reason: "",
            track: raw.track,
            videoDesc: raw.videoDesc,
            shouldGenerateImage,
            flowId: null,
            index,
            createTime: now,
          });
          storyboardId = Number(inserted[0]);
          // SQLite may reuse an ID after a failed write. Remove any legacy orphan
          // relation before inserting this storyboard's authoritative bindings.
          await trx("o_assets2Storyboard").where({ storyboardId }).del();
          if (assets.length) {
            await trx("o_assets2Storyboard").insert(assets.map((assetId, sort) => ({ storyboardId, assetId, sort })));
          }
        });
        const saved = await u.db("o_storyboard").where({ id: storyboardId, projectId, scriptId }).first();
        const verifiedAssets = (
          await u.db("o_assets2Storyboard").where({ storyboardId }).orderBy("sort", "asc").orderBy("assetId", "asc").pluck("assetId")
        ).map(Number);
        if (!saved || saved.videoDesc !== raw.videoDesc || saved.prompt !== (raw.prompt || "") || !sameIds(verifiedAssets, assets)) {
          throw new Error("正式分镜写入后回读校验失败");
        }
        socket.emit("flowDataUpdated", { reason: "storyboardAdded", storyboardId });
        thinking.appendText(`真实分镜 ID：${storyboardId}`);
        thinking.updateTitle("正式分镜面板写入完成");
        thinking.complete();
        return { success: true, storyboardId, index, associateAssetsIds: assets, autoAssociated: Boolean(tableBindings[index]?.length) };
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
        const associateAssetsIds = (
          await u.db("o_assets2Storyboard").where({ storyboardId: row.id }).orderBy("sort", "asc").orderBy("assetId", "asc").pluck("assetId")
        ).map(Number);
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
          if (assets.length) {
            await trx("o_assets2Storyboard").insert(assets.map((assetId, sort) => ({ storyboardId: expectedStoryboardId, assetId, sort })));
          }
        });
        const verified = (
          await u
            .db("o_assets2Storyboard")
            .where({ storyboardId: expectedStoryboardId })
            .orderBy("sort", "asc")
            .orderBy("assetId", "asc")
            .pluck("assetId")
        ).map(Number);
        if (!sameIds(verified, assets)) throw new Error("分镜资产绑定写入后回读校验失败");
        socket.emit("updateStoryboardAssetBinding", { storyboardId: expectedStoryboardId, associateAssetsIds: verified });
        socket.emit("flowDataUpdated", { reason: "storyboardBinding", storyboardId: expectedStoryboardId });
        return { success: true, verified: true, storyboardId: expectedStoryboardId, associateAssetsIds: verified };
      },
    }),

    update_storyboard_prompt: tool({
      description: "使用真实分镜 ID 定点更新已有分镜提示词，不新增分镜、不触发生成",
      inputSchema: z.object({
        storyboardId: z.number().int().positive(),
        prompt: z.string().trim().min(1),
        videoDesc: z.string().optional(),
      }),
      execute: async ({ storyboardId, prompt, videoDesc }) => {
        ensureContext();
        const patch: Record<string, string> = { prompt };
        if (videoDesc !== undefined) patch.videoDesc = videoDesc;
        const updated = await u.db("o_storyboard").where({ id: storyboardId, projectId, scriptId }).update(patch);
        if (!updated) throw new Error(`真实分镜不存在：${storyboardId}`);
        const saved = await u.db("o_storyboard").where({ id: storyboardId, projectId, scriptId }).select("prompt", "videoDesc").first();
        if (saved?.prompt !== prompt || (videoDesc !== undefined && saved.videoDesc !== videoDesc)) throw new Error("分镜提示词写入后回读校验失败");
        socket.emit("updateStoryboardPrompt", { storyboardId, prompt, videoDesc });
        socket.emit("flowDataUpdated", { reason: "storyboardPrompt", storyboardId });
        return { success: true, storyboardId, prompt };
      },
    }),
  };

  return toolsNames ? Object.fromEntries(Object.entries(tools).filter(([name]) => toolsNames.includes(name))) : tools;
};
