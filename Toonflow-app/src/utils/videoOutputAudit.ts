export interface VideoOutputAuditInput {
  expectedRatio?: string;
  expectedDuration?: number;
  width?: number;
  height?: number;
  actualDuration?: number;
}

export interface VideoOutputAuditResult {
  actualRatio: string | null;
  aspectMismatch: boolean;
  durationDriftSeconds: number | null;
  issues: string[];
}

function parseRatio(value: unknown): number | null {
  const match = String(value || "").replace(/\s/g, "").match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : null;
}

export function auditVideoOutput(input: VideoOutputAuditInput): VideoOutputAuditResult {
  const actualRatio = input.width && input.height
    ? `${input.width}x${input.height}`
    : null;
  const actualRatioValue = input.width && input.height ? input.width / input.height : null;
  const expectedRatioValue = parseRatio(input.expectedRatio || "16:9");
  const aspectMismatch = actualRatioValue != null && expectedRatioValue != null
    ? Math.abs(actualRatioValue - expectedRatioValue) / expectedRatioValue > 0.005
    : false;
  const durationDriftSeconds = Number.isFinite(input.expectedDuration) && Number.isFinite(input.actualDuration)
    ? Number((Number(input.actualDuration) - Number(input.expectedDuration)).toFixed(3))
    : null;
  const issues: string[] = [];
  if (aspectMismatch) {
    issues.push(`实际画幅 ${actualRatio} 与项目画幅 ${input.expectedRatio || "16:9"} 不一致`);
  }
  if (durationDriftSeconds != null && Math.abs(durationDriftSeconds) > 0.5) {
    issues.push(`实际时长偏差 ${durationDriftSeconds > 0 ? "+" : ""}${durationDriftSeconds}s`);
  }
  return { actualRatio, aspectMismatch, durationDriftSeconds, issues };
}
