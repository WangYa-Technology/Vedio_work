export type GenerationState = "未生成" | "生成中" | "已完成" | "生成失败";

export type AssetType = "role" | "tool" | "scene" | "clip";

export interface DeriveAsset {
  id: number;
  assetsId: number | null;
  name: string;
  prompt: string;
  desc: string;
  src: string;
  flowId?: number;
  state: GenerationState;
  type: AssetType;
  errorReason?: string;
}

export interface AssetItem {
  id: number;
  name: string;
  desc: string;
  prompt: string;
  src: string;
  state: GenerationState;
  type: AssetType;
  flowId?: number;
  derive: DeriveAsset[];
  errorReason?: string;
}

export interface Storyboard {
  id?: number;
  duration?: number;
  prompt: string;
  trackId?: number;
  track?: string;
  index?: number | null;
  associateAssetsIds?: number[];
  src: string | null;
  state: GenerationState;
  flowId?: number;
  reason?: string;
  videoDesc: string;
  shouldGenerateImage: number;
}

export interface VideoListItem {
  id: number;
  prompt: string;
  duration: number;
  storyboardId: number;
  trackId: number;
}

export interface FlowData {
  script: string;
  scriptPlan: string;
  assets: AssetItem[];
  storyboardTable: string;
  storyboard: Storyboard[];
  workbench: {
    videoList: VideoListItem[];
  };
}
