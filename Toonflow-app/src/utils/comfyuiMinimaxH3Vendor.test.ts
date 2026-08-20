import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import axios from "axios";
import FormData from "form-data";
import { VM } from "vm2";
import compileVendorCode from "./compileVendorCode";

const ASSET_INPUTS = new Set([
  "lora_name",
  "unet_name",
  "vae_name",
  "clip_name",
  "clip_name1",
  "clip_name2",
  "model_name",
  "base_model",
  "overlay_model",
]);

function loadTemplates(source: string) {
  return ["U05", "U09", "U15"].map((name) => {
    const encoded = source.match(new RegExp(`const ${name}_WORKFLOW_TEMPLATE_BASE64 = "([A-Za-z0-9+/=]+)";`))?.[1];
    assert.ok(encoded, `missing ${name} workflow template`);
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  });
}

function buildObjectInfo(templates: Record<string, any>[]) {
  const optionSets = new Map<string, Set<string>>();
  const objectInfo: Record<string, any> = {};

  for (const workflow of templates) {
    for (const node of Object.values<any>(workflow)) {
      objectInfo[node.class_type] ||= { input: { required: {} } };
      for (const [inputName, value] of Object.entries(node.inputs || {})) {
        if (!ASSET_INPUTS.has(inputName) || typeof value !== "string") continue;
        const key = `${node.class_type}:${inputName}`;
        const values = optionSets.get(key) || new Set<string>();
        values.add(value);
        optionSets.set(key, values);
      }
    }
  }

  for (const nodeType of [
    "ExtendIntermediateSigmas",
    "H3SigmaRefiner",
    "MinimaxH3LatentUpscalerNode3D",
    "VHS_LoadVideo",
    "LoadAudio",
    "TrimAudioDuration",
  ]) {
    objectInfo[nodeType] ||= { input: { required: {} } };
  }

  const obsoleteU09Lora = "minimax/minimax_h3_turbo_4step_diffusion_model.safetensors";
  const compatibleU09Lora = "minimax/minimax_h3_turbo_4步加速_comfyui.safetensors";
  const incompatibleButPresentU09Lora = "minimax/minimax_h3_turbo_4step.safetensors";
  for (const [key, values] of optionSets) {
    const separator = key.lastIndexOf(":");
    const nodeType = key.slice(0, separator);
    const inputName = key.slice(separator + 1);
    if (nodeType === "LoraLoaderBypassModelOnly" && inputName === "lora_name") {
      values.delete(obsoleteU09Lora);
      values.add(compatibleU09Lora);
      values.add(incompatibleButPresentU09Lora);
    }
    objectInfo[nodeType].input.required[inputName] = [[...values]];
  }
  // The normalized AIEverything graph is not part of the legacy U05/U09/U15
  // templates above, so provide the cloud asset names it uses as test metadata.
  objectInfo.UNETLoader ||= { input: { required: {} } };
  objectInfo.UNETLoader.input.required.unet_name = [[
    ...((objectInfo.UNETLoader.input.required.unet_name?.[0] || []) as string[]),
    "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
  ]];
  objectInfo.VAELoader ||= { input: { required: {} } };
  objectInfo.VAELoader.input.required.vae_name = [[
    ...((objectInfo.VAELoader.input.required.vae_name?.[0] || []) as string[]),
    "minimax_h3_video_vae_int8_convrot.safetensors",
    "minimax_h3_audio_vae_fp32.safetensors",
  ]];
  objectInfo.CLIPLoader ||= { input: { required: {} } };
  objectInfo.CLIPLoader.input.required.clip_name = [[
    ...((objectInfo.CLIPLoader.input.required.clip_name?.[0] || []) as string[]),
    "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
  ]];
  objectInfo.LoraLoaderModelOnly ||= { input: { required: {} } };
  objectInfo.LoraLoaderModelOnly.input.required.lora_name = [[
    ...((objectInfo.LoraLoaderModelOnly.input.required.lora_name?.[0] || []) as string[]),
    "miniMaxH3/minimax_h3_ref2v_lightx2v_turbo_4step_v0.1_resized_avg_rank_20_bf16.safetensors",
  ]];
  return objectInfo;
}

function runVendor(code: string) {
  const sandbox: Record<string, any> = {
    exports: {},
    axios,
    FormData,
    Buffer,
    fetch,
    logger: () => undefined,
    urlToBase64: async (url: string) => {
      const response = await axios.get(url, { responseType: "arraybuffer" });
      const mime = response.headers["content-type"] || "application/octet-stream";
      return `data:${mime};base64,${Buffer.from(response.data).toString("base64")}`;
    },
    pollTask: async (fn: () => Promise<any>) => fn(),
    zipImage: async (value: string) => value,
    zipImageResolution: async (value: string) => value,
    mergeImages: async () => "",
  };
  new VM({ timeout: 0, sandbox, compiler: "javascript", eval: false, wasm: false }).run(code);
  return sandbox.exports;
}

test("keeps zealman workflows isolated, returns U09 second pass, and adapts the universal U09 graph", async () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "data/vendor/comfyui-minimax-h3.ts"),
    "utf8",
  );
  const templates = loadTemplates(source);
  const objectInfo = buildObjectInfo(templates);
  const submitted: Record<string, any>[] = [];
  const histories = new Map<string, { outputNodeId: string }>();

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/object_info") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(objectInfo));
      return;
    }
    if (request.method === "POST" && url.pathname === "/upload/image") {
      request.resume();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ name: `reference-${submitted.length}.png` }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/UniversalRef_minimaxH3/upload") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("latin1");
        const kind = body.includes(".mp4") ? "video" : body.includes(".wav") ? "audio" : "image";
        const extension = kind === "video" ? "mp4" : kind === "audio" ? "wav" : "png";
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          name: `universal-reference-${submitted.length}.${extension}`,
          subfolder: "UniversalRef_minimaxH3",
          kind,
          has_audio: kind === "video",
        }));
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/prompt") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const workflow = JSON.parse(Buffer.concat(chunks).toString("utf8")).prompt;
        submitted.push(workflow);
        const promptId = `prompt-${submitted.length}`;
        const outputNodeId = workflow["609"] ? "609" : workflow["168"] ? "168" : "180";
        histories.set(promptId, { outputNodeId });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ prompt_id: promptId }));
      });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/history/")) {
      const promptId = decodeURIComponent(url.pathname.slice("/history/".length));
      const history = histories.get(promptId);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        [promptId]: {
          status: { status_str: "success", completed: true },
          outputs: {
            [history!.outputNodeId]: {
              files: [{ filename: `${promptId}.mp4`, type: "output" }],
            },
          },
        },
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/view") {
      response.setHeader("content-type", "video/mp4");
      response.end(Buffer.from("video"));
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const runtime = runVendor(compileVendorCode(source));
    runtime.vendor.inputValues.baseUrl = `http://127.0.0.1:${address.port}`;
    const image = "data:image/png;base64,iVBORw0KGgo=";
    const config = {
      prompt: "test",
      duration: 5,
      resolution: "736x416",
      aspectRatio: "16:9",
      imageBase64: [image],
      audio: false,
    };

    for (const modelName of [
      "minimax-h3-zealman-u05",
      "minimax-h3-zealman-u09-v4",
      "minimax-h3-zealman-u09-universal",
      "minimax-h3-zealman-u15",
    ]) {
      const requestConfig = modelName === "minimax-h3-zealman-u09-universal"
        ? {
            ...config,
            referenceList: [
              { type: "image", base64: image },
              { type: "video", base64: "data:video/mp4;base64,AAAA" },
              { type: "audio", base64: "data:audio/wav;base64,AAAA" },
            ],
          }
        : config;
      const result = await runtime.videoRequest(requestConfig, { modelName, audio: "optional" });
      assert.match(result, /^data:video\/mp4;base64,/);
    }

    const universalResult = await runtime.videoRequest({
      ...config,
      referenceList: [
        { type: "image", base64: image },
        { type: "image", base64: image },
      ],
      parameters: {
        refImageSize: "max",
        samplerName: "dpmpp_2m",
        scheduler: "beta",
        steps: 7,
        seed: 42,
        loraStrength: 0.8,
        sigmaVideoShift: 10,
        sigmaAudioShift: 2,
        sigmaExtraSteps: 6,
        sigmaStart: 0.75,
        sigmaSpacing: "cosine",
        attentionBackend: "pytorch attention",
      },
    }, { modelName: "minimax-h3-universal-reference", audio: true });
    assert.match(universalResult, /^data:video\/mp4;base64,/);
    const universalWorkflow = submitted[submitted.length - 1];
    assert.equal(universalWorkflow["universal_ref_image_0"].inputs.image, "reference-4.png");
    assert.equal(universalWorkflow["136"].inputs.ref_image_size, "max");
    assert.equal(universalWorkflow["123"].inputs.sampler_name, "dpmpp_2m");
    assert.equal(universalWorkflow["124"].inputs.scheduler, "beta");
    assert.equal(universalWorkflow["124"].inputs.steps, 7);
    assert.equal(universalWorkflow["129"].inputs.noise_seed, 42);
    assert.equal(universalWorkflow["174"].inputs.strength_model, 0.8);
    assert.equal(universalWorkflow["187"].inputs.spacing, "cosine");
    assert.equal(universalWorkflow["186"].inputs.attention, "pytorch attention");

    assert.equal(submitted[0]["671"].inputs.lora_name, templates[0]["671"].inputs.lora_name);
    assert.equal(
      submitted[1]["205"].inputs.lora_name,
      "minimax/minimax_h3_turbo_4步加速_comfyui.safetensors",
    );
    assert.equal(submitted[3]["150"].inputs.lora_name, templates[2]["150"].inputs.lora_name);
    assert.ok(submitted[0]["609"] && !submitted[0]["612"]);
    assert.ok(submitted[1]["168"] && !submitted[1]["285"]);
    assert.deepEqual(submitted[1]["168"].inputs.images, ["225", 0]);
    assert.equal(submitted[1]["351"].class_type, "ExtendIntermediateSigmas");
    assert.deepEqual(submitted[1]["222"].inputs.sigmas, ["351", 0]);
    assert.ok(submitted[2]["168"] && !submitted[2]["285"]);
    assert.equal(submitted[2]["323"].class_type, "MinimaxH3LatentUpscalerNode3D");
    assert.deepEqual(submitted[2]["322"].inputs.av_latent, ["125", 0]);
    assert.equal(submitted[2]["351"].class_type, "H3SigmaRefiner");
    assert.equal(submitted[2]["352"].class_type, "H3SigmaRefiner");
    assert.deepEqual(submitted[2]["186"].inputs["ref_images.ref_image_0"], ["u09_universal_image_resize_0", 0]);
    assert.deepEqual(submitted[2]["186"].inputs["ref_videos.ref_video_0"], ["u09_universal_video_1", 0]);
    assert.deepEqual(submitted[2]["186"].inputs["ref_video_audios.ref_video_audio_0"], ["u09_universal_video_1", 2]);
    assert.deepEqual(submitted[2]["186"].inputs["ref_audios.ref_audio_0"], ["u09_universal_audio_trim_2", 0]);
    assert.equal(submitted[2]["u09_universal_video_1"].class_type, "VHS_LoadVideo");
    assert.equal(submitted[2]["u09_universal_audio_load_2"].class_type, "LoadAudio");
    assert.equal(submitted[2]["u09_universal_audio_trim_2"].class_type, "TrimAudioDuration");
    assert.ok(submitted[3]["180"]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
