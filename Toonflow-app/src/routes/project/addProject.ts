import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { DEFAULT_IMAGE_NEGATIVE_PROMPT } from "@/constants/imagePromptDefaults";
import { EMPTY_PROJECT_GLOBAL_CONTEXT, ProjectGlobalContextSchema } from "@/schemas/projectGlobalContext";
const router = express.Router();

// 新增项目
export default router.post(
  "/",
  validateFields({
    projectType: z.string(),
    name: z.string(),
    intro: z.string(),
    type: z.string(),
    artStyle: z.string(),
    negativePrompt: z.string().optional(),
    directorManual: z.string(),
    videoRatio: z.string(),
    imageModel: z.string(),
    videoModel: z.string(),
    imageQuality: z.string(),
    mode: z.string(),
    projectGlobalContext: ProjectGlobalContextSchema.optional(),
  }),
  async (req, res) => {
    const {
      projectType,
      name,
      intro,
      type,
      directorManual,
      artStyle,
      negativePrompt,
      videoRatio,
      imageModel,
      videoModel,
      imageQuality,
      mode,
      projectGlobalContext,
    } = req.body;
    const projectId = Date.now();
    const normalizedGlobalContext = ProjectGlobalContextSchema.parse(projectGlobalContext ?? EMPTY_PROJECT_GLOBAL_CONTEXT);

    await u.db.transaction(async (trx) => {
      await trx("o_project").insert({
        id: projectId,
        projectType,
        name,
        intro,
        type,
        artStyle,
        negativePrompt: String(negativePrompt ?? DEFAULT_IMAGE_NEGATIVE_PROMPT).trim(),
        videoRatio,
        directorManual,
        userId: req.authUser!.id,
        imageModel,
        videoModel,
        createTime: projectId,
        imageQuality,
        mode,
      });
      await trx("o_agentWorkData").insert({
        projectId,
        key: "scriptAgent",
        data: JSON.stringify({
          storySkeleton: "",
          adaptationStrategy: "",
          projectGlobalContext: normalizedGlobalContext,
        }),
        createTime: projectId,
        updateTime: projectId,
      });
    });

    res.status(200).send(success({ message: "新增项目成功", projectId }));
  },
);
