import { z } from "zod";

export const vendorInputSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["text", "password", "url"]),
  required: z.boolean(),
  placeholder: z.string().optional(),
});

const referenceModeSchema = z.string().regex(
  /^(audioReference|videoReference|textReference|imageReference)(:[1-9]\d*)?$/,
  "引用模式必须是有效类型，可选附带正整数数量",
);

const workflowParameterValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const videoModelParameterSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["select", "number", "boolean"]),
  default: workflowParameterValueSchema,
  description: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  options: z.array(z.object({
    label: z.string(),
    value: workflowParameterValueSchema,
    description: z.string().optional(),
  })).optional(),
});

export const vendorModelSchema = z.discriminatedUnion("type", [
  z.object({
    name: z.string(),
    modelName: z.string(),
    type: z.literal("text"),
    think: z.boolean(),
    associationSkills: z.string().optional(),
  }),
  z.object({
    name: z.string(),
    modelName: z.string(),
    type: z.literal("image"),
    mode: z.array(z.enum(["text", "singleImage", "multiReference"])),
    associationSkills: z.string().optional(),
  }),
  z.object({
    name: z.string(),
    modelName: z.string(),
    type: z.literal("video"),
    mode: z.array(
      z.union([
        z.enum([
          "singleImage",
          "multiImage",
          "startEndRequired",
          "endFrameOptional",
          "startFrameOptional",
          "text",
          "audioReference",
          "videoReference",
          "textReference",
          "imageReference",
        ]),
        z.array(referenceModeSchema).min(1),
      ]),
    ),
    audio: z.union([z.literal("optional"), z.boolean()]),
    parameters: z.array(videoModelParameterSchema).optional(),
    durationResolutionMap: z.array(
      z.object({
        duration: z.array(z.number()),
        resolution: z.array(z.string()),
      }),
    ),
    associationSkills: z.string().optional(),
  }),
]);

export const vendorConfigSchema = z.object({
  id: z.string(),
  author: z.string(),
  description: z.string().optional(),
  name: z.string(),
  icon: z.string().optional(),
  inputs: z.array(vendorInputSchema),
  inputValues: z.record(z.string(), z.string()),
  models: z.array(vendorModelSchema),
});
