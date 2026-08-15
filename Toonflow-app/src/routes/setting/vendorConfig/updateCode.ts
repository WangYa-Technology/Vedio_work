import express from "express";
import { serializeError } from "serialize-error";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { z } from "zod";
import compileVendorCode from "@/utils/compileVendorCode";
import { vendorConfigSchema } from "@/schemas/vendorConfig";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.string(),
    tsCode: z.string(),
  }),
  async (req, res) => {
    try {
      const { tsCode, id } = req.body;
      const jsCode = compileVendorCode(tsCode);
      const exports = u.vm(jsCode);
      if (!exports) return res.status(400).send(success("脚本文件必须导出对象"));
      if (!exports.textRequest) return res.status(400).send(success("脚本文件必须导出文本请求对象"));
      if (!exports.imageRequest) return res.status(400).send(success("脚本文件必须导出图像请求对象"));
      if (!exports.videoRequest) return res.status(400).send(success("脚本文件必须导出视频请求对象"));
      if (!exports.vendor) return res.status(400).send(success("脚本文件必须导出vendor对象"));
      const vendor = exports.vendor;
      const result = vendorConfigSchema.safeParse(vendor);
      if (!result.success) {
        const errorMsg = result.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
        return res.status(400).send(error(`vendor配置校验失败: ${errorMsg}`));
      }
      await u
        .db("o_vendorConfig")
        .where("id", id)
        .update({
          author: vendor.author,
          description: vendor.description || "",
          name: vendor.name,
          icon: vendor.icon || "",
          inputs: JSON.stringify(vendor.inputs ?? []),
          inputValues: JSON.stringify(vendor.inputValues ?? {}),
          models: JSON.stringify(vendor.models ?? []),
          code: tsCode,
          createTime: Date.now(),
        });
      res.status(200).send(success(result.data));
    } catch (err) {
      console.log(err);
      res.status(400).send(error(serializeError(err).message || "未知错误"));
    }
  },
);
