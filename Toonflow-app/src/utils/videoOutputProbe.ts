import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProbedVideoMetadata {
  width: number;
  height: number;
  duration: number;
}

export async function probeVideoFile(filePath: string): Promise<ProbedVideoMetadata | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,duration",
      "-of", "json",
      filePath,
    ]);
    const stream = JSON.parse(stdout).streams?.[0];
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    const duration = Number(stream?.duration);
    if (![width, height, duration].every(Number.isFinite)) return null;
    return { width, height, duration };
  } catch {
    return null;
  }
}
