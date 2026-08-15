/**
 * ComfyUI MiniMax H3 视频供应商
 *
 * 基于云端镜像中已验证的 MiniMax H3 工作流族：
 * - 多参考图（Reference-to-Video，最多 9 张）
 * - 首尾帧 / 单图（Image-to-Video）
 * - 文生视频（同一 Image-to-Video 节点，不连接参考帧）
 *
 * U01/U04/U05/U06/U09/U11/U12/U13 的共同核心都是 ReferenceToVideo，
 * U02/U08/U13 的首尾帧分支共同使用 ImageToVideo，U03/U08 的文生分支
 * 使用同一节点但不传首帧。这里按“工作流配置档”暴露，避免把旧版 UI 图
 * 直接当作 /prompt API 图提交。
 */

type ReferenceType = "image" | "audio" | "video";

interface ReferenceItem {
  type: ReferenceType;
  base64: string;
}

interface VideoConfig {
  prompt: string;
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  imageBase64?: string[];
  referenceList?: ReferenceItem[];
  audio?: boolean;
}

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: any[];
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
}

interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}

declare const axios: any;
declare const Buffer: any;
declare const FormData: any;
declare const logger: (message: string) => void;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
declare const urlToBase64: (url: string) => Promise<string>;
declare const exports: any;

const vendor = {
  id: "comfyui-minimax-h3",
  version: "2.0.1",
  author: "Toonflow",
  name: "ComfyUI · MiniMax H3",
  description: "通过 ComfyUI API 适配云端镜像中的 MiniMax H3 工作流族（多参考图、5 图、高保真、首尾帧/单图、文生视频）。旧版 UI 工作流统一映射到当前官方节点，避免 UUID 和动态输入失效。",
  inputs: [
    { key: "baseUrl", label: "ComfyUI 地址", type: "url", required: true, placeholder: "https://your-comfyui.example.com" },
    { key: "clientId", label: "客户端标识（可选）", type: "text", required: false, placeholder: "toonflow" },
  ],
  inputValues: {
    baseUrl: "https://u1118922-7862ca9a26e2.westd.seetacloud.com:8443",
    clientId: "toonflow",
  },
  models: [
    {
      name: "MiniMax H3 · 多参考图（LightX2V 加速）",
      modelName: "minimax-h3-reference-to-video",
      type: "video",
      // 云端工作流仅声明 ref_image_0 ... ref_image_8，共 9 个参考图槽位。
      // 界面数量必须与工作流上限一致，避免用户选择第 10 张后产生非法参数。
      mode: [["imageReference:9"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["864x480", "1024x576", "480x864", "576x1024"] }],
    },
    {
      name: "MiniMax H3 · 多参考图（基础质量）",
      modelName: "minimax-h3-reference-to-video-quality",
      type: "video",
      mode: [["imageReference:9"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["864x480", "1024x576", "480x864", "576x1024"] }],
    },
    {
      name: "MiniMax H3 · 多参考图（5 图加速）",
      modelName: "minimax-h3-reference-to-video-5",
      type: "video",
      mode: [["imageReference:5"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["864x480", "1024x576", "480x864", "576x1024"] }],
    },
    {
      name: "MiniMax H3 · 多参考图（高保真 MAX）",
      modelName: "minimax-h3-reference-to-video-max",
      type: "video",
      mode: [["imageReference:9"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["864x480", "1024x576", "480x864", "576x1024"] }],
    },
    {
      name: "MiniMax H3 · 首尾帧 / 单图",
      modelName: "minimax-h3-image-to-video",
      type: "video",
      mode: ["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional"],
      audio: false,
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["864x480", "1024x576", "480x864", "576x1024"] }],
    },
    {
      name: "MiniMax H3 · 文生视频",
      modelName: "minimax-h3-text-to-video",
      type: "video",
      mode: ["text"],
      audio: false,
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["864x480", "1024x576", "480x864", "576x1024"] }],
    },
    {
      name: "MiniMax H3 · 全能参考 / 原生音画（U07）",
      modelName: "minimax-h3-audio-unified",
      type: "video",
      mode: ["text", ["imageReference:9"]],
      audio: true,
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["864x480", "1024x576", "480x864", "576x1024"] }],
    },
    {
      name: "MiniMax H3 · 导演台 / 高保真核心（U10）",
      modelName: "minimax-h3-director",
      type: "video",
      mode: ["text", ["imageReference:9"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["864x480", "1024x576", "480x864", "576x1024"] }],
    },
  ],
};

// 已从云端实例导出的可提交 /prompt 工作流，保留全部依赖节点和模型配置。
const WORKFLOW_TEMPLATE_BASE64 = "eyI5MiI6eyJpbnB1dHMiOnsiZmlsZW5hbWVfcHJlZml4IjoiY29tZnl1aSIsImZvcm1hdCI6ImF1dG8iLCJjb2RlYyI6ImF1dG8iLCJ2aWRlbyI6WyIxMzAiLDBdfSwiY2xhc3NfdHlwZSI6IlNhdmVWaWRlbyIsIl9tZXRhIjp7InRpdGxlIjoi5L+d5a2Y6KeG6aKRIn19LCIxMTkiOnsiaW5wdXRzIjp7InZhZV9uYW1lIjoibWluaW1heF9oM192aWRlb192YWVfZnAxNi5zYWZldGVuc29ycyJ9LCJjbGFzc190eXBlIjoiVkFFTG9hZGVyIiwiX21ldGEiOnsidGl0bGUiOiLliqDovb1WQUUifX0sIjEyMCI6eyJpbnB1dHMiOnsidmFlX25hbWUiOiJtaW5pbWF4X2gzX2F1ZGlvX3ZhZV9mcDMyLnNhZmV0ZW5zb3JzIn0sImNsYXNzX3R5cGUiOiJWQUVMb2FkZXIiLCJfbWV0YSI6eyJ0aXRsZSI6IuWKoOi9vVZBRSJ9fSwiMTIxIjp7ImlucHV0cyI6eyJzYW1wbGVzIjpbIjEyNSIsMF0sInZhZSI6WyIxMjAiLDBdfSwiY2xhc3NfdHlwZSI6IlZBRURlY29kZUF1ZGlvIiwiX21ldGEiOnsidGl0bGUiOiJWQUXop6PnoIHvvIjpn7PpopHvvIkifX0sIjEyMiI6eyJpbnB1dHMiOnsic2FtcGxlcyI6WyIxMjUiLDBdLCJ2YWUiOlsiMTE5IiwwXX0sImNsYXNzX3R5cGUiOiJWQUVEZWNvZGUiLCJfbWV0YSI6eyJ0aXRsZSI6IlZBReino+eggSJ9fSwiMTIzIjp7ImlucHV0cyI6eyJzYW1wbGVyX25hbWUiOiJyZXNfbXVsdGlzdGVwIn0sImNsYXNzX3R5cGUiOiJLU2FtcGxlclNlbGVjdCIsIl9tZXRhIjp7InRpdGxlIjoiS+mHh+agt+WZqOmAieaLqSJ9fSwiMTI0Ijp7ImlucHV0cyI6eyJzY2hlZHVsZXIiOiJzaW1wbGUiLCJzdGVwcyI6MTIsImRlbm9pc2UiOjEsIm1vZGVsIjpbIjE1NSIsMF19LCJjbGFzc190eXBlIjoiQmFzaWNTY2hlZHVsZXIiLCJfbWV0YSI6eyJ0aXRsZSI6IuWfuuacrOiwg+W6puWZqCJ9fSwiMTI1Ijp7ImlucHV0cyI6eyJub2lzZSI6WyIxMjkiLDBdLCJndWlkZXIiOlsiMTI2IiwwXSwic2FtcGxlciI6WyIxMjMiLDBdLCJzaWdtYXMiOlsiMTI0IiwwXSwibGF0ZW50X2ltYWdlIjpbIjEzNiIsMV19LCJjbGFzc190eXBlIjoiU2FtcGxlckN1c3RvbUFkdmFuY2VkIiwiX21ldGEiOnsidGl0bGUiOiLoh6rlrprkuYnph4fmoLflmajvvIjpq5jnuqfvvIkifX0sIjEyNiI6eyJpbnB1dHMiOnsibW9kZWwiOlsiMTU1IiwwXSwiY29uZGl0aW9uaW5nIjpbIjEzNiIsMF19LCJjbGFzc190eXBlIjoiQmFzaWNHdWlkZXIiLCJfbWV0YSI6eyJ0aXRsZSI6IuWfuuacrOW8leWvvOWZqCJ9fSwiMTI3Ijp7ImlucHV0cyI6eyJ1bmV0X25hbWUiOiJtaW5pbWF4L21pbmltYXhfaDNfcmVmMnZhX2ludDhfY29udnJvdC5zYWZldGVuc29ycyIsIndlaWdodF9kdHlwZSI6ImRlZmF1bHQifSwiY2xhc3NfdHlwZSI6IlVORVRMb2FkZXIiLCJfbWV0YSI6eyJ0aXRsZSI6IlVOZXTliqDovb3lmagifX0sIjEyOCI6eyJpbnB1dHMiOnsiY2xpcF9uYW1lIjoicXdlbjN2bF8zMmJfbWluaW1heF9oM19pbnQ4X2NvbnZyb3Quc2FmZXRlbnNvcnMiLCJ0eXBlIjoibWluaW1heCIsImRldmljZSI6ImRlZmF1bHQifSwiY2xhc3NfdHlwZSI6IkNMSVBMb2FkZXIiLCJfbWV0YSI6eyJ0aXRsZSI6IuWKoOi9vUNMSVAifX0sIjEyOSI6eyJpbnB1dHMiOnsibm9pc2Vfc2VlZCI6NDYxNjkyNjc2MTIwMTI0fSwiY2xhc3NfdHlwZSI6IlJhbmRvbU5vaXNlIiwiX21ldGEiOnsidGl0bGUiOiLpmo/mnLrlmarms6IifX0sIjEzMCI6eyJpbnB1dHMiOnsiZnBzIjoyNCwiYml0X2RlcHRoIjo4LCJpbWFnZXMiOlsiMTUwIiwwXSwiYXVkaW8iOlsiMTIxIiwwXX0sImNsYXNzX3R5cGUiOiJDcmVhdGVWaWRlbyIsIl9tZXRhIjp7InRpdGxlIjoi5Yib5bu66KeG6aKRIn19LCIxMzEiOnsiaW5wdXRzIjp7ImV4cHJlc3Npb24iOiJtYXgoNSwgcm91bmQoYSAqIDI0KSkgKyAoNSAtIChtYXgoNSwgcm91bmQoYSAqIDI0KSkgJSAxNykpICUgMTciLCJ2YWx1ZXMuYSI6WyIxNDciLDBdfSwiY2xhc3NfdHlwZSI6IkNvbWZ5TWF0aEV4cHJlc3Npb24iLCJfbWV0YSI6eyJ0aXRsZSI6IuaVsOWtpuihqOi+vuW8jyJ9fSwiMTM2Ijp7ImlucHV0cyI6eyJwcm9tcHQiOlsiMTQ2IiwwXSwid2lkdGgiOlsiMTQ1IiwxXSwiaGVpZ2h0IjpbIjE0NSIsMl0sImxlbmd0aCI6WyIxMzEiLDFdLCJyZWZfaW1hZ2Vfc2l6ZSI6Im1hdGNoIiwiY2xpcCI6WyIxMjgiLDBdLCJ2YWUiOlsiMTE5IiwwXSwiYXVkaW9fdmFlIjpbIjEyMCIsMF0sInJlZl9pbWFnZXMucmVmX2ltYWdlXzAiOlsiMTM3IiwwXSwicmVmX2ltYWdlcy5yZWZfaW1hZ2VfMSI6WyIxMzkiLDBdLCJyZWZfaW1hZ2VzLnJlZl9pbWFnZV8yIjpbIjE0MSIsMF19LCJjbGFzc190eXBlIjoiTWluaU1heEgzUmVmZXJlbmNlVG9WaWRlbyIsIl9tZXRhIjp7InRpdGxlIjoiTWluaU1heCBIMyDlj4LogIPnlJ/miJDop4bpopEifX0sIjEzNyI6eyJpbnB1dHMiOnsiaW1hZ2UiOiJVbnRpdGxlZCg0KS5qcGcifSwiY2xhc3NfdHlwZSI6IkxvYWRJbWFnZSIsIl9tZXRhIjp7InRpdGxlIjoi5Yqg6L295Zu+5YOPIn19LCIxMzkiOnsiaW5wdXRzIjp7ImltYWdlIjoiVW50aXRsZWQoNSkuanBnIn0sImNsYXNzX3R5cGUiOiJMb2FkSW1hZ2UiLCJfbWV0YSI6eyJ0aXRsZSI6IuWKoOi9veWbvuWDjyJ9fSwiMTQxIjp7ImlucHV0cyI6eyJpbWFnZSI6IlVudGl0bGVkKDYpLmpwZyJ9LCJjbGFzc190eXBlIjoiTG9hZEltYWdlIiwiX21ldGEiOnsidGl0bGUiOiLliqDovb3lm77lg48ifX0sIjE0NSI6eyJpbnB1dHMiOnsi6aKE6K6+5YiG6L6o546HIjoi6Ieq5a6a5LmJIiwi5qiq56uW5a+56LCDIjpmYWxzZSwi5om56YeP5aSn5bCPIjoxLCLoh6rlrprkuYnlrr0iOjg2NCwi6Ieq5a6a5LmJ6auYIjo0ODAsIue8qeaUvuWAjeaVsCI6IjMyIn0sImNsYXNzX3R5cGUiOiJXSklMYXRlbnRQcmVzZXQiLCJfbWV0YSI6eyJ0aXRsZSI6IvCfk5AgTGF0ZW506aKE6K6+IChFbXB0eSBMYXRlbnQgUHJlc2V0KSJ9fSwiMTQ2Ijp7ImlucHV0cyI6eyJwcm9tcHQiOiJBZXN0aGV0aWM6IENpbmVtYXRpYyB3dXhpYSBhdG1vc3BoZXJlLCBzdGF0aWMgaGFuZGhlbGQgbWVkaXVtIHNob3QsIHdhcm0gb2lsLWxhbnRlcm4gZ2xvdyBjdXR0aW5nIHRocm91Z2ggY29vbCByYWlueSBtaXN0LCBtb29keSBhbmQgaGVhbGluZyBmaWxtIGdyYWluIHRleHR1cmVcbltTSE9UIDFdXG5EdXJhdGlvbjogMDowMCAtIDA6MDNcbkNhbWVyYSBNb3Rpb246IFN0YXRpYyBoYW5kaGVsZCBtZWRpdW0gc2hvdCwgc3VidGxlIGZyYW1lIHRyZW1vciBmcm9tIGZhbGxpbmcgcmFpblxuVmlzdWFsIFByb21wdDogU3RhcnRpbmcgZnJvbSB0aGUgcmVmZXJlbmNlIGZyYW1lLiBJbnNpZGUgYSB3b29kZW4gY2Fub3B5IGJvYXQgZHJpZnRpbmcgb24gYSBtaXN0eSBsYWtlIGF0IG5pZ2h0LCB0aGUgeW91bmcgd29tYW4gaW4gcmVkIGVtYnJvaWRlcmVkIGhhbmZ1IOKAlCB3aXRoIGJsYWNrIGhhaXIgaW4gYSB0cmFkaXRpb25hbCB1cGRvIGFuZCBkYW5nbGluZyBlYXJyaW5ncyDigJQgaG9sZHMgdGhlIHdoaXRlIGZveCB3aXRoIHRoaWNrIHB1cmUtd2hpdGUgZnVyIGluIGJvdGggYXJtcy4gU2hlIGJlbmRzIGZvcndhcmQgYW5kIGxvd2VycyB0aGUgZm94IG9udG8gYSBkcnkgd29vZGVuIHBsYW5rIGluc2lkZSB0aGUgY2FiaW4sIHRoZW4gZ3JhYnMgYSBjbG90aCBhbmQgd2lwZXMgcmFpbndhdGVyIG9mZiBpdHMgZnVyIHdpdGggZmlybSBzdHJva2luZyBtb3Rpb25zLiBBIGxpdCBvaWwgbGFudGVybiBoYW5ncyBiZXNpZGUgaGVyLCBjYXN0aW5nIHdhcm0gZ29sZGVuIGxpZ2h0IGFjcm9zcyB0aGUgY2FiaW4gd2hpbGUgcmFpbiBzdHJlYWtzIGRvd24gb3V0c2lkZS4gTG90dXMgbGVhdmVzIGZsb2F0IG9uIHRoZSBkYXJrIGxha2Ugc3VyZmFjZSB2aXNpYmxlIHRocm91Z2ggdGhlIGJvYXQgZW50cmFuY2UuXG5BdWRpbyAvIERpYWxvZ3VlOiDmt4XmsqXpm6jlo7DjgIHmnKjoiLnlkLHlkYDlo7DjgIHmuZbmsLTovbvmi43oiLnoiLcgW+eOr+Wig+mfs+S4uuS4u++8jOatpOmVnOaXoOS6uuWjsF1cbltTSE9UIDJdXG5EdXJhdGlvbjogMDowMyAtIDA6MDdcbkNhbWVyYSBNb3Rpb246IFN1YnRsZSBoYW5kaGVsZCBwdXNoLWluLCBzbG93IGFuZCBzdGVhZHkgdG93YXJkIGJvdGggZmlndXJlc1xuVmlzdWFsIFByb21wdDogVGhlIHdoaXRlIGZveCBzaXRzIHVwcmlnaHQgd2l0aCBwb2ludGVkIGVhcnMgcmFpc2VkIGhpZ2gsIHN0YXJpbmcgZGlyZWN0bHkgYXQgaGVyIHdpdGggYWxlcnQgZGFyayBleWVzIGFuZCByaWdpZCBwb3N0dXJlLiBUaGUgd29tYW4gbG93ZXJzIGhlcnNlbGYgaW50byBhIHNxdWF0IGFuZCByZWFjaGVzIG9uZSBoYW5kIHRvd2FyZCB0aGUgZm94J3MgaGVhZCwgdGhlbiBzdHJva2VzIGZpcm1seSBhbG9uZyBpdHMgaGVhZCBhbmQgYmFjayB3aXRoIHJlcGVhdGVkIGRvd253YXJkIHBhbG0gbW90aW9ucy4gU2hlIHNwZWFrcyBkaXJlY3RseSB0byB0aGUgZm94IHdpdGggbmF0dXJhbCBsaXAtc3luYywgaGVyIGV4cHJlc3Npb24gY2FsbSBhbmQgc3RlYWR5LiBUaGUgZm94J3MgYnVzaHkgdGFpbCBzdGF5cyB0ZW5zZSBiZWhpbmQgaXRzIGJvZHkgYnV0IG1ha2VzIG5vIGF0dGVtcHQgdG8gZmxlZS4gV2FybSBsYW50ZXJuIGxpZ2h0IGZsaWNrZXJzIGFjcm9zcyBib3RoIHRoZWlyIGZhY2VzLlxuQXVkaW8gLyBEaWFsb2d1ZTog6Zuo5aOw5oyB57ut44CB5biD5paZ5pGp5pOm5aOwIFvlubTovbvlpbPlo7AgLyDmuKnova/kvY7nvJNdIOS6uuWjsO+8mlwi5Yir5oCV77yM5bey57uP5rKh5LqL5LqG44CC6Zuo5YaN5aSn77yM5oiR5Lmf5LiN5Lya5oqK5L2g5Lii5LiL44CCXCJcbltTSE9UIDNdXG5EdXJhdGlvbjogMDowNyAtIDA6MTFcbkNhbWVyYSBNb3Rpb246IFN0YXRpYyBoYW5kaGVsZCBtZWRpdW0gY2xvc2UtdXAsIG1pbmltYWwgbW92ZW1lbnQgaG9sZGluZyBib3RoIGluIGZyYW1lXG5WaXN1YWwgUHJvbXB0OiBUaGUgd2hpdGUgZm94IHJlbGVhc2VzIHRlbnNpb24gZnJvbSBpdHMgc2hvdWxkZXJzIGFuZCBzZXR0bGVzIGl0cyBicmVhdGhpbmcsIGV5ZXMgc29mdGVuaW5nIGludG8gYSBjYWxtZXIgZ2F6ZS4gVGhlIHdvbWFuIG1haW50YWlucyBleWUgY29udGFjdCB3aXRoIHRoZSBmb3ggYW5kIHNtaWxlcyB3YXJtbHkgd2hpbGUgY29udGludWluZyBzdGVhZHkgc3Ryb2tpbmcgbW90aW9ucyBhbG9uZyBpdHMgYmFjayB3aXRoIGhlciBvcGVuIHBhbG0uIFNoZSBzcGVha3MgYWdhaW4gd2l0aCBjbGVhciBsaXAgbW92ZW1lbnQsIG5vZGRpbmcgaGVyIGhlYWQgYXMgc2hlIHRhbGtzLiBUaGUgZm94J3MgYnVzaHkgdGFpbCByZWxheGVzIGFuZCByZXN0cyBvbiB0aGUgd29vZGVuIGZsb29yLiBSYWluIGNvbnRpbnVlcyBmYWxsaW5nIG91dHNpZGUgdGhlIGJvYXQgY2Fub3B5LCBhbmQgbWlzdCBkcmlmdHMgYWNyb3NzIHRoZSBsYWtlLlxuQXVkaW8gLyBEaWFsb2d1ZTog6Zuo5aOw5riQ5p+U44CB54Gv54Gr6L275b6u5pGH5puz5aOwIFvlubTovbvlpbPlo7AgLyDovbvlo7DluKbnrJHmhI9dIOS6uuWjsO+8mlwi5LiL5qyh5L2g5Y+v5b6X5aSa5bCP5b+D54K55ZGA77yM5aSW6Z2i55qE5Z2P5Lq65a6e5Zyo5aSq5aSa5LqG44CCXCJcbltTSE9UIDRdXG5EdXJhdGlvbjogMDoxMSAtIDA6MTVcbkNhbWVyYSBNb3Rpb246IFZlcnkgc2xvdyBoYW5kaGVsZCBwdWxsLWJhY2ssIGdlbnRsZSBkcmlmdCBrZWVwaW5nIGJvdGggZmlndXJlcyBjZW50ZXJlZFxuVmlzdWFsIFByb21wdDogVGhlIHdoaXRlIGZveCBsb3dlcnMgaXRzIGZ1bGwgYm9keSBpbnRvIGEgcmVzdGluZyBwb3NpdGlvbiBhbmQgY3VybHMgaXRzIHRoaWNrIGJ1c2h5IHRhaWwgYXJvdW5kIGl0c2VsZiBpbiBhIGRlbGliZXJhdGUgd3JhcHBpbmcgbW90aW9uLiBUaGUgd29tYW4gc3RheXMgY3JvdWNoZWQgYmVzaWRlIGl0LCBrZWVwaW5nIG9uZSBoYW5kIG9uIHRoZSBmb3gncyBiYWNrIHdpdGggc2xvdywgY29uc2lzdGVudCBzdHJva2luZy4gVGhlIG9pbCBsYW50ZXJuIGZsYW1lIHN3aW5ncyBiYWNrIGFuZCBmb3J0aCBpbnNpZGUgdGhlIGNhYmluLCBwYWludGluZyBtb3ZpbmcgZ29sZGVuIHN0cmVha3Mgb24gdGhlIHdvb2RlbiB3YWxscy4gTWlzdCBkcmlmdHMgYWNyb3NzIHRoZSBkYXJrIGxha2Ugc3VyZmFjZSB2aXNpYmxlIHRocm91Z2ggdGhlIGJvYXQgZW50cmFuY2UsIGFuZCBsb3R1cyBsZWF2ZXMgc2hpZnQgZ2VudGx5IGluIHRoZSByYWluLiBCb3RoIGZpZ3VyZXMgcmVtYWluIGNlbnRlcmVkIGluIHRoZSBmcmFtZSDigJQgdGhlIHJlZCBoYW5mdSBhbmQgd2hpdGUgZnVyIGdsb3dpbmcgYWdhaW5zdCB0aGUgZGFyayByYWlueSBiYWNrZ3JvdW5kLlxuQXVkaW8gLyBEaWFsb2d1ZTog6Zuo5aOw44CB5rmW5rC05aOw44CB54Gv54Gr5pGH5puz5aOw5Lqk57uHIFvnjq/looPpn7PmlLblsL7vvIzml6Dkurrlo7BdIn0sImNsYXNzX3R5cGUiOiJDUiBQcm9tcHQgVGV4dCIsIl9tZXRhIjp7InRpdGxlIjoi4pqZ77iPIENSIFByb21wdCBUZXh0In19LCIxNDciOnsiaW5wdXRzIjp7InZhbHVlIjoxMH0sImNsYXNzX3R5cGUiOiJQcmltaXRpdmVGbG9hdCIsIl9tZXRhIjp7InRpdGxlIjoiRmxvYXQgKER1cmF0aW9uKSJ9fSwiMTQ5Ijp7ImlucHV0cyI6eyJvZmZsb2FkX21vZGVsIjp0cnVlLCJvZmZsb2FkX2NhY2hlIjp0cnVlLCJhbnl0aGluZyI6WyIxMjIiLDBdfSwiY2xhc3NfdHlwZSI6IlZSQU1DbGVhbnVwIiwiX21ldGEiOnsidGl0bGUiOiLwn46IVlJBTS1DbGVhbnVwIn19LCIxNTAiOnsiaW5wdXRzIjp7ImNsZWFuX2ZpbGVfY2FjaGUiOnRydWUsImNsZWFuX3Byb2Nlc3NlcyI6dHJ1ZSwiY2xlYW5fZGxscyI6dHJ1ZSwicmV0cnlfdGltZXMiOjMsImFueXRoaW5nIjpbIjE0OSIsMF19LCJjbGFzc190eXBlIjoiUkFNQ2xlYW51cCIsIl9tZXRhIjp7InRpdGxlIjoi8J+OiFJBTS1DbGVhbnVwIn19LCIxNTQiOnsiaW5wdXRzIjp7ImxvcmFfbmFtZSI6Im1pbmltYXgvbWluaW1heF9oM19mbDJ2X2xpZ2h0eDJ2X3R1cmJvXzRzdGVwX3YwLjFfY29tZnlfcmVzaXplZF9hdmdfcmFua18yMV9iZjE2LnNhZmV0ZW5zb3JzIiwic3RyZW5ndGhfbW9kZWwiOjEsIm1vZGVsIjpbIjEyNyIsMF19LCJjbGFzc190eXBlIjoiTG9yYUxvYWRlck1vZGVsT25seSIsIl9tZXRhIjp7InRpdGxlIjoiTG9SQeWKoOi9veWZqO+8iOS7heaooeWei++8iSJ9fSwiMTU1Ijp7ImlucHV0cyI6eyJtb2RlbCI6WyIxNTQiLDBdfSwiY2xhc3NfdHlwZSI6Ik1pbmlNYXhIM01lbW9yeUVmZmljaWVudFNhZ2VBdHRlbnRpb25QYXRjaCIsIl9tZXRhIjp7InRpdGxlIjoiTWluaU1heCBIMyBNZW0gRWZmIFNhZ2UgQXR0ZW50aW9uIFBhdGNoIn19fQ==";

// 云端 MiniMaxH3ReferenceToVideo 的 COMFY_AUTOGROW_V3 声明最大为 9 个参考图槽位
//（ref_image_0 ... ref_image_8）。超过该数量时 ComfyUI 会把第 10 个槽位作为
// 非法函数参数传给 execute，直接报 unexpected keyword argument。
const MAX_REFERENCE_IMAGES = 9;

/**
 * 云端镜像中的 17 个工作流并不是 17 套互不兼容的 API：它们最终都归并到
 * MiniMaxH3ReferenceToVideo（Ref2VA）或 MiniMaxH3ImageToVideo（T2VA/I2VA/FL2VA）
 * 两个官方节点。这里保留“工作流档案”而不是直接提交 ComfyUI 的旧 UI JSON，
 * 因为 UI JSON 中有旧版 UUID 节点，无法保证在镜像升级后仍能执行。
 */
type WorkflowKind = "reference" | "image" | "text";

interface WorkflowProfile {
  kind: WorkflowKind;
  maxImages: number;
  refImageSize: "match" | "max";
  useLightX2V: boolean;
  useAudioConditioning?: boolean;
  workflowFamily: string;
}

const WORKFLOW_PROFILES: Record<string, WorkflowProfile> = {
  // U01 / U05 / U06 / U09 / U12 / U13 的 Ref2VA 主链
  "minimax-h3-reference-to-video": {
    kind: "reference", maxImages: 9, refImageSize: "match", useLightX2V: true,
    workflowFamily: "U01/U06/U12/U13 多参考图加速主链",
  },
  // U01 基础版：同一节点，不接 LightX2V LoRA / Sage patch
  "minimax-h3-reference-to-video-quality": {
    kind: "reference", maxImages: 9, refImageSize: "match", useLightX2V: false,
    workflowFamily: "U01 多参考图基础质量",
  },
  // U04
  "minimax-h3-reference-to-video-5": {
    kind: "reference", maxImages: 5, refImageSize: "match", useLightX2V: true,
    workflowFamily: "U04 五图参考加速",
  },
  // U06 / U09 的高保真分支
  "minimax-h3-reference-to-video-max": {
    kind: "reference", maxImages: 9, refImageSize: "max", useLightX2V: false,
    workflowFamily: "U06/U09 高保真参考图",
  },
  // U02 / U08 / U13 的首尾帧和单图公共主链
  "minimax-h3-image-to-video": {
    kind: "image", maxImages: 2, refImageSize: "match", useLightX2V: true,
    workflowFamily: "U02/U08/U13 首尾帧/单图",
  },
  // U03 / U08 的文生分支：同一 ImageToVideo 节点，不连接 optional 帧
  "minimax-h3-text-to-video": {
    kind: "text", maxImages: 0, refImageSize: "match", useLightX2V: true,
    workflowFamily: "U03/U08 文生视频",
  },
  // U07 的 MiniMaxH3AudioConditioningT8 统一音画节点。当前 Toonflow 只提供
  // 图片/提示词输入，因此先接入原生音画条件主链，音频参考素材仍由云端工作流
  // 自己管理；后续 VideoConfig 增加 audioBase64 后可继续映射 drive_audio。
  "minimax-h3-audio-unified": {
    kind: "reference", maxImages: 9, refImageSize: "max", useLightX2V: false,
    useAudioConditioning: true, workflowFamily: "U07 全能参考/原生音画",
  },
  // U10 导演台的核心仍是 Ref2VA，导演台 timeline_data 暂未进入画布参数，
  // 但参考图与提示词可以使用同一高保真主链。
  "minimax-h3-director": {
    kind: "reference", maxImages: 9, refImageSize: "max", useLightX2V: false,
    workflowFamily: "U10 导演台 Ref2VA 核心",
  },
};

// 镜像内已读取的全部 H3 工作流文件。它们按当前 ComfyUI object_info 的官方节点
// 归一化到上面的档案；带二采、超分、音频同步、导演台的文件保留其核心 H3 条件链，
// 但不会伪造 Toonflow 尚未提供的音频/时间线输入。
const CLOUD_WORKFLOW_CATALOG: Record<string, string> = {
  "U01-minimax_h3_light2v多图参考生视频加速版": "minimax-h3-reference-to-video",
  "U01-minimax_h3_多图参考生视频基础版": "minimax-h3-reference-to-video-quality",
  "U02-minimax_h3_light2v首尾帧图生视频加速版": "minimax-h3-image-to-video",
  "U02-minimax_h3_lightX2v首尾帧图生视频加速版V2": "minimax-h3-image-to-video",
  "U02-minimax_h3_图生视频基础版": "minimax-h3-image-to-video",
  "U03-minimax_h3_light2v-文生视频加速版": "minimax-h3-text-to-video",
  "U03-minimax_h3_文生视频基础版": "minimax-h3-text-to-video",
  "U04-minimax_h3_light2v-5图参考生视频加速版": "minimax-h3-reference-to-video-5",
  "U05-minimax_h3-多参考图light2v加速生成-LTX超分": "minimax-h3-reference-to-video",
  "U06-minimax_h3_lightX2v多图参考生视频V4": "minimax-h3-reference-to-video-max",
  "U07-MiniMax-H3全能参考工作流Work-Fisher": "minimax-h3-audio-unified",
  "U08-Aiden-minimax文-图-首尾帧生视频-自动切换-8G-48G": "minimax-h3-image-to-video",
  "U09-Minimax-H3二采重绘-秒变清晰-超高一致性-效率起飞wuwukasi": "minimax-h3-reference-to-video-max",
  "U10-DaSiWa-MiniMaxH3-MythicAlchemy-v12导演台": "minimax-h3-reference-to-video-max",
  "U11-Minimax-H3-图生视频-音频同步": "minimax-h3-audio-unified",
  "U12-minimax_h3-全能无加速-可选超分": "minimax-h3-reference-to-video-quality",
  "U13-MiniMaxH3-黑鹤加速视频流整合": "minimax-h3-reference-to-video",
};

const getWorkflowProfile = (modelName: string): WorkflowProfile =>
  WORKFLOW_PROFILES[modelName] || WORKFLOW_PROFILES["minimax-h3-reference-to-video"];

const unsupported = (feature: string) => {
  throw new Error(`ComfyUI MiniMax H3 供应商不支持${feature}`);
};

const textRequest = () => unsupported("文本模型");
const imageRequest = () => unsupported("图片模型");
const ttsRequest = () => unsupported("语音模型");

const getBaseUrl = () => {
  const value = String(vendor.inputValues.baseUrl || "").trim().replace(/\/+$/, "");
  if (!value) throw new Error("请先填写 ComfyUI 地址");
  return value;
};

const parseDataUrl = (value: string) => {
  const match = String(value || "").match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!match) throw new Error("参考素材不是有效的 base64 Data URL");
  const mimeType = match[1];
  const extensionMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  return { mimeType, data: match[2], extension: extensionMap[mimeType] || "png" };
};

const uploadImage = async (baseUrl: string, dataUrl: string, index: number) => {
  const parsed = parseDataUrl(dataUrl);
  const form = new FormData();
  const fileName = `toonflow-h3-${Date.now()}-${index}.${parsed.extension}`;
  form.append("image", Buffer.from(parsed.data, "base64"), {
    filename: fileName,
    contentType: parsed.mimeType,
  });
  form.append("overwrite", "true");
  const response = await axios.post(`${baseUrl}/upload/image`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 120000,
  });
  const uploaded = response.data || {};
  if (!uploaded.name) throw new Error(`ComfyUI 上传参考图失败：${JSON.stringify(uploaded).slice(0, 500)}`);
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
};

const getDimensions = (config: VideoConfig) => {
  const match = String(config.resolution || "").match(/(\d+)\s*[x*×]\s*(\d+)/i);
  if (match) {
    const width = Math.max(64, Math.round(Number(match[1]) / 32) * 32);
    const height = Math.max(64, Math.round(Number(match[2]) / 32) * 32);
    return { width, height };
  }
  return config.aspectRatio === "9:16" ? { width: 480, height: 864 } : { width: 864, height: 480 };
};

const cloneWorkflow = () => JSON.parse(Buffer.from(WORKFLOW_TEMPLATE_BASE64, "base64").toString("utf8"));

const selectReferenceImages = (references: ReferenceItem[], prompt: string, maxImages = MAX_REFERENCE_IMAGES) => {
  if (references.length <= maxImages) {
    return { references, originalIndexes: references.map((_, index) => index) };
  }

  // 画布视频流程通常把最后一张图作为分镜图。云端最多支持 9 张时，保留前 8
  // 张资产和最后一张分镜图，避免丢失真正驱动镜头内容的参考图。
  const keepStoryboard = /分镜图|storyboard/i.test(prompt);
  const originalIndexes = keepStoryboard
    ? [...Array(Math.max(0, maxImages - 1)).keys(), references.length - 1]
    : [...Array(maxImages).keys()];
  return {
    references: originalIndexes.map((index) => references[index]),
    originalIndexes,
  };
};

const rewriteReferenceTags = (prompt: string, originalIndexes: number[], originalCount: number) => {
  if (originalIndexes.length === originalCount) return prompt;

  const indexMap = new Map(originalIndexes.map((originalIndex, newIndex) => [originalIndex + 1, newIndex + 1]));
  let result = String(prompt || "");

  // 删除被裁掉的参考图声明行，避免提示词继续声称该图片存在。
  for (let originalNumber = originalCount; originalNumber >= 1; originalNumber -= 1) {
    if (indexMap.has(originalNumber)) continue;
    const linePattern = new RegExp(`(^|\\n)\\s*@?图片\\s*${originalNumber}\\s*[:：].*(?=\\n|$)`, "g");
    result = result.replace(linePattern, "$1");
  }

  // 先占位再替换，避免图片 10 -> 图片 9 时发生二次替换。
  result = result.replace(/@?图片\s*(\d+)/g, (full: string, numberText: string) => {
    const number = Number(numberText);
    const mapped = indexMap.get(number);
    return mapped ? `__TOONFLOW_H3_REF_${mapped}__` : full;
  });
  return result.replace(/__TOONFLOW_H3_REF_(\d+)__/g, "@图片$1");
};

const configureWorkflow = (config: VideoConfig, imageNames: string[], profile: WorkflowProfile) => {
  const workflow = cloneWorkflow();
  const { width, height } = getDimensions(config);

  workflow["145"].inputs["自定义宽"] = width;
  workflow["145"].inputs["自定义高"] = height;
  workflow["146"].inputs.prompt = String(config.prompt || "").trim();
  workflow["147"].inputs.value = Math.max(5, Math.min(15, Math.round(Number(config.duration) || 5)));
  workflow["129"].inputs.noise_seed = Math.floor(Math.random() * 9007199254740991);
  workflow["92"].inputs.filename_prefix = `toonflow/minimax-h3/${Date.now()}`;

  // 加速档案沿用云端 LightX2V + Sage Attention；基础/高保真档案只使用原始 UNet。
  // 两个采样节点都直接接 patch 后的模型，移除 patch 时必须同时改回 127。
  if (profile.useLightX2V) {
    workflow["127"].inputs.unet_name = profile.kind === "reference"
      ? "minimax/minimax_h3_ref2va_int8_convrot.safetensors"
      : "minimax/minimax_h3_fl2va_pruned_int8_convrot.safetensors";
  } else {
    delete workflow["154"];
    delete workflow["155"];
    workflow["124"].inputs.model = ["127", 0];
    workflow["126"].inputs.model = ["127", 0];
    workflow["127"].inputs.unet_name = profile.kind === "reference"
      ? "minimax/minimax_h3_ref2va_pruned_int8_convrot.safetensors"
      : "minimax/minimax_h3_fl2va_pruned_int8_convrot.safetensors";
  }

  const conditioning = workflow["136"];
  const templateNode = workflow["137"];
  const initialNodeIds = ["137", "139", "141"];
  const removeDynamicInputs = () => {
    Object.keys(conditioning.inputs).forEach((key) => {
      if (/^(ref_images|ref_videos|ref_video_audios|ref_audios)\./.test(key)) delete conditioning.inputs[key];
    });
    delete conditioning.inputs.first_frame;
    delete conditioning.inputs.last_frame;
  };

  // MiniMaxH3ImageToVideo 仅接受 first_frame / last_frame；U02/U08/U13 的旧版
  // 工作流虽然包含 UUID 节点，但这里使用镜像当前 object_info 中的官方节点名。
  if (profile.kind === "image" || profile.kind === "text") {
    conditioning.class_type = "MiniMaxH3ImageToVideo";
    conditioning.inputs = {
      prompt: conditioning.inputs.prompt,
      width: conditioning.inputs.width,
      height: conditioning.inputs.height,
      length: conditioning.inputs.length,
      clip: conditioning.inputs.clip,
      vae: conditioning.inputs.vae,
    };
    if (profile.kind === "image") {
      if (imageNames[0]) conditioning.inputs.first_frame = ["137", 0];
      if (imageNames[1]) conditioning.inputs.last_frame = ["139", 0];
    }
    delete workflow["120"];
    delete workflow["121"];
    delete workflow["130"].inputs.audio;
  } else {
    removeDynamicInputs();
    if (profile.useAudioConditioning) {
      conditioning.class_type = "MiniMaxH3AudioConditioningT8";
      conditioning.inputs = {
        clip: conditioning.inputs.clip,
        video_vae: conditioning.inputs.vae,
        audio_vae: ["120", 0],
        prompt: conditioning.inputs.prompt,
        width: conditioning.inputs.width,
        height: conditioning.inputs.height,
        length: conditioning.inputs.length,
        task_type: imageNames.length ? "Ref2VA" : "T2VA",
        audio_mode: "native",
        audio_denoise_strength: 0.35,
        add_source_as_reference: true,
        prompt_primary_audio_ordinal: 0,
        strict_prompt_tags: true,
        ref_image_size: profile.refImageSize,
        reference_video_policy: "official_2_to_15s",
      };
    } else {
      conditioning.class_type = "MiniMaxH3ReferenceToVideo";
      conditioning.inputs.ref_image_size = profile.refImageSize;
      conditioning.inputs.audio_vae = ["120", 0];
    }
  }

  // MiniMaxH3ReferenceToVideo / ImageToVideo 的图片输入节点统一从已上传文件名重建。
  // 基准工作流中有 3 个槽位，其余参考图按同样结构动态扩展。
  initialNodeIds.forEach((nodeId) => delete workflow[nodeId]);
  const imageLimit = profile.kind === "reference" ? profile.maxImages : 2;
  imageNames.slice(0, imageLimit).forEach((imageName, index) => {
    const nodeId = index < initialNodeIds.length ? initialNodeIds[index] : `h3_ref_${index}`;
    workflow[nodeId] = {
      ...templateNode,
      inputs: { ...templateNode.inputs, image: imageName },
    };
    if (profile.kind === "reference") {
      conditioning.inputs[`ref_images.ref_image_${index}`] = [nodeId, 0];
    }
  });

  // 参考图模式会生成原生音轨；仅在用户开启声音时接入 CreateVideo。
  // 断开后未被引用的音频解码节点不会执行，输出文件也不会包含音轨。
  if (profile.kind === "reference" && config.audio !== false) {
    workflow["130"].inputs.audio = profile.useAudioConditioning ? ["136", 2] : ["121", 0];
    if (profile.useAudioConditioning) delete workflow["121"];
  } else if (profile.kind === "reference") {
    delete workflow["130"].inputs.audio;
  }
  return workflow;
};

const findVideoOutput = (value: any): { filename: string; subfolder?: string; type?: string } | null => {
  if (!value || typeof value !== "object") return null;
  if (typeof value.filename === "string" && /\.(mp4|webm|mov|mkv)$/i.test(value.filename)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    const found = findVideoOutput(nested);
    if (found) return found;
  }
  return null;
};

const getFailureReason = (history: any): string | undefined => {
  const status = history?.status || {};
  if (status.status_str === "error") {
    const messages = status.messages || [];
    const executionError = messages.find(
      (item: any) => Array.isArray(item) && item[0] === "execution_error" && item[1] && typeof item[1] === "object",
    )?.[1];
    if (executionError) {
      const node = executionError.node_id ? `节点 ${executionError.node_id}` : "工作流节点";
      const detail = executionError.exception_message || executionError.exception_type || "未知执行错误";
      return `ComfyUI ${node}执行失败：${detail}`;
    }
    return messages.map((item: any) => {
      if (!Array.isArray(item)) return String(item);
      const detail = item[1];
      if (detail && typeof detail === "object") {
        return detail.message || detail.exception_message || detail.exception_type || item[0];
      }
      return `${item[0]}: ${String(detail)}`;
    }).join("; ") || "ComfyUI 工作流执行失败";
  }
  return undefined;
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  const baseUrl = getBaseUrl();
  if (!String(config.prompt || "").trim()) {
    throw new Error("请先填写视频提示词");
  }

  const profile = getWorkflowProfile(model.modelName);
  // 画布目前优先传 referenceList；旧版调用方只传 imageBase64 时也保持兼容。
  const configuredReferences = (config.referenceList || []).filter((item) => item.type === "image");
  const fallbackReferences: ReferenceItem[] = (config.imageBase64 || []).map((base64) => ({ type: "image", base64 }));
  const references = configuredReferences.length ? configuredReferences : fallbackReferences;
  let selected: { references: ReferenceItem[]; originalIndexes: number[] } = { references: [], originalIndexes: [] };

  if (profile.kind === "reference") {
    if (references.length < 1) {
      throw new Error(`MiniMax H3 ${profile.workflowFamily}需要至少 1 张参考图`);
    }
    selected = selectReferenceImages(references, config.prompt, profile.maxImages);
  } else if (profile.kind === "image") {
    if (references.length < 1) {
      throw new Error("MiniMax H3 首尾帧/单图工作流需要至少 1 张图片");
    }
    // UI 的单图、首帧、尾帧三种模式最终都落到同一官方节点；最多取前两张，
    // 第一张作为 first_frame，第二张作为 last_frame。
    selected = { references: references.slice(0, 2), originalIndexes: references.slice(0, 2).map((_, i) => i) };
    if (references.length > 2) logger("[ComfyUI MiniMax H3] 首尾帧模式最多使用前两张参考图");
  }

  if (selected.references.length < references.length && profile.kind === "reference") {
    logger(
      `[ComfyUI MiniMax H3] 当前工作流最多支持 ${profile.maxImages} 张参考图，` +
      `本次保留 ${selected.references.length} 张（${references.length} 张中裁剪），并重排提示词引用`,
    );
  }
  const imageNames = await Promise.all(selected.references.map((item, index) => uploadImage(baseUrl, item.base64, index)));
  const prompt = profile.kind === "reference"
    ? rewriteReferenceTags(config.prompt, selected.originalIndexes, references.length)
    : String(config.prompt || "").trim();
  const shouldGenerateAudio = model.audio === true || (model.audio === "optional" && config.audio !== false);
  const workflow = configureWorkflow({ ...config, prompt, audio: shouldGenerateAudio }, imageNames, profile);
  const clientId = String(vendor.inputValues.clientId || "toonflow").trim() || "toonflow";

  logger(
    `[ComfyUI MiniMax H3] 提交任务：model=${model.modelName}, workflow=${profile.workflowFamily}, ` +
      `refs=${imageNames.length}, duration=${workflow["147"].inputs.value}s, audio=${shouldGenerateAudio}`,
  );
  const submitted = await axios.post(
    `${baseUrl}/prompt`,
    { prompt: workflow, client_id: clientId },
    { headers: { "Content-Type": "application/json" }, timeout: 120000 },
  );
  const promptId = submitted.data?.prompt_id;
  if (!promptId) throw new Error(`ComfyUI 未返回 prompt_id：${JSON.stringify(submitted.data || {}).slice(0, 500)}`);

  const completed = await pollTask(
    async () => {
      const response = await axios.get(`${baseUrl}/history/${encodeURIComponent(promptId)}`, { timeout: 120000 });
      const history = response.data?.[promptId];
      if (!history) return { completed: false };
      const failure = getFailureReason(history);
      if (failure) return { completed: true, error: failure };
      const video = findVideoOutput(history.outputs?.["92"]);
      if (!video) return { completed: false };

      const query = [
        `filename=${encodeURIComponent(video.filename)}`,
        `subfolder=${encodeURIComponent(video.subfolder || "")}`,
        `type=${encodeURIComponent(video.type || "output")}`,
      ].join("&");
      return { completed: true, data: `${baseUrl}/view?${query}` };
    },
    5000,
    90 * 60 * 1000,
  );

  if (completed.error) throw new Error(completed.error);
  if (!completed.data) throw new Error("ComfyUI 任务未返回视频文件");
  return await urlToBase64(completed.data);
};

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
