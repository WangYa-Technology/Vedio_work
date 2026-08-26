import { tool, type Tool } from "ai";
import { z } from "zod";
import u from "@/utils";
import ResTool from "@/socket/resTool";

interface ToolConfig {
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
}

const assetType = z.enum(["role", "scene", "tool"]);

const assetTypeLabels: Record<z.infer<typeof assetType>, string> = {
  role: "角色",
  scene: "场景",
  tool: "道具",
};

export default ({ resTool, msg }: ToolConfig) => {
  const { socket } = resTool;
  const projectId = Number(resTool.data.projectId);
  const scriptId = Number(resTool.data.scriptId);

  const tools: Record<string, Tool> = {
    add_baseAsset: tool({
      description: "新增缺失的基础资产，或复用项目内同名同类型基础资产，并关联到当前剧本",
      inputSchema: z.object({
        name: z.string().trim().min(1).describe("基础资产名称"),
        type: assetType.describe("资产类型：role 角色、scene 场景、tool 道具"),
        desc: z.string().trim().min(1).describe("忠于剧本的可视化资产描述"),
        prompt: z.string().trim().min(1).describe("可直接用于图片生成的资产提示词"),
        remark: z.string().trim().optional().nullable().describe("可选备注"),
      }),
      execute: async ({ name, type, desc, prompt, remark }) => {
        if (!Number.isFinite(projectId) || !Number.isFinite(scriptId)) {
          throw new Error("生产 Agent 缺少项目或剧本上下文");
        }

        const normalizedName = name.trim();
        const thinking = msg.thinking(`正在补建${assetTypeLabels[type]}基础资产...`);
        let assetId = 0;
        let created = false;

        try {
          await u.db.transaction(async (trx) => {
            const script = await trx("o_script")
              .where({ id: scriptId, projectId })
              .select("id")
              .first();
            if (!script) throw new Error("当前剧本不存在或不属于当前项目");

            const sameName = await trx("o_assets")
              .where({ projectId })
              .whereNull("assetsId")
              .whereRaw("trim(name) = ?", [normalizedName])
              .select("id", "type")
              .first();

            if (sameName && sameName.type !== type) {
              throw new Error(
                `基础资产“${normalizedName}”已作为${assetTypeLabels[sameName.type as z.infer<typeof assetType>] || sameName.type}存在，不能重复创建为${assetTypeLabels[type]}`,
              );
            }

            if (sameName) {
              assetId = Number(sameName.id);
            } else {
              const inserted = await trx("o_assets").insert({
                assetsId: null,
                projectId,
                name: normalizedName,
                type,
                describe: desc.trim(),
                originalPrompt: prompt.trim(),
                prompt: prompt.trim(),
                remark: remark?.trim() || null,
                promptState: "已完成",
                promptErrorReason: "",
                startTime: Date.now(),
              });
              assetId = Number(inserted[0]);
              created = true;
            }

            await trx("o_scriptAssets")
              .insert({ scriptId, assetId })
              .onConflict(["scriptId", "assetId"])
              .ignore();

            const workData = await trx("o_agentWorkData")
              .where({ projectId, episodesId: scriptId, key: "productionFlowData" })
              .first();
            let flowData: Record<string, unknown> = {};
            try {
              flowData = workData?.data ? JSON.parse(workData.data) : {};
            } catch {
              throw new Error("现有生产工作区数据格式无效，已阻止基础资产补建");
            }
            const pendingIds = Array.isArray(flowData.pendingBaseAssetIds)
              ? flowData.pendingBaseAssetIds.map(Number).filter(Number.isSafeInteger)
              : [];
            const data = JSON.stringify({
              ...flowData,
              pendingBaseAssetIds: [...new Set([...pendingIds, assetId])],
            });
            const now = Date.now();
            if (workData) {
              await trx("o_agentWorkData")
                .where({ id: workData.id, projectId, episodesId: scriptId })
                .update({ data, updateTime: now });
            } else {
              const maxRow = await trx("o_agentWorkData").max("id as id").first();
              await trx("o_agentWorkData").insert({
                id: Number((maxRow as any)?.id || 0) + 1,
                projectId,
                episodesId: scriptId,
                key: "productionFlowData",
                data,
                createTime: now,
                updateTime: now,
              });
            }
          });

          const saved = await u.db("o_assets")
            .leftJoin("o_image", "o_assets.imageId", "o_image.id")
            .where({ "o_assets.id": assetId, "o_assets.projectId": projectId, "o_assets.type": type })
            .whereNull("o_assets.assetsId")
            .select(
              "o_assets.id",
              "o_assets.name",
              "o_assets.type",
              "o_assets.describe",
              "o_assets.prompt",
              "o_assets.imageId",
              "o_image.filePath as imageFilePath",
              "o_image.state as imageState",
            )
            .first();
          const linked = await u.db("o_scriptAssets").where({ scriptId, assetId }).first();
          if (!saved || !linked || String(saved.name).trim() !== normalizedName) {
            throw new Error("基础资产写入后回读校验失败");
          }
          const hasImage =
            /^https?:\/\//i.test(String(saved.imageFilePath || "")) ||
            (Boolean(saved.imageFilePath) && await u.oss.fileExists(String(saved.imageFilePath)));

          socket.emit("flowDataUpdated", {
            reason: created ? "baseAssetCreated" : "baseAssetLinked",
            assetId,
          });
          thinking.updateTitle(created ? "基础资产补建完成" : "已关联现有基础资产");
          thinking.complete();
          return {
            success: true,
            created,
            assetId,
            name: saved.name,
            type: saved.type,
            hasImage,
            imageState: saved.imageState || (hasImage ? "已完成" : "未生成"),
          };
        } catch (error) {
          thinking.appendText(u.error(error).message);
          thinking.updateTitle("基础资产补建失败");
          thinking.complete();
          throw error;
        }
      },
    }),
  };

  return tools;
};
