// 活跃任务校验：同一会话（isolationKey）内只允许"最新启动的任务"写入正式产物。
// 断连后在后台继续运行的旧任务若晚于新任务完成，其产物会被拒绝写入，
// 防止过期结果覆盖新任务已保存的分镜表 / 导演规划。
const latestTaskGeneration = new Map<string, number>();
let generationCounter = 0;

export function beginAgentTask(sessionKey: string): number {
  const generation = ++generationCounter;
  latestTaskGeneration.set(sessionKey, generation);
  return generation;
}

export function isLatestAgentTask(sessionKey: string, generation: number): boolean {
  return latestTaskGeneration.get(sessionKey) === generation;
}

export function endAgentTask(sessionKey: string, generation: number): void {
  if (latestTaskGeneration.get(sessionKey) === generation) latestTaskGeneration.delete(sessionKey);
}
