import { Namespace, Socket } from "socket.io";
import u from "@/utils";
import * as agent from "@/agents/scriptAgent/index";
import ResTool from "@/socket/resTool";
import { decodeSocketUser, userOwnsProject } from "@/middleware/auth";
import { getAgentIsolationKey, ScriptAgentRuntimeRecorder } from "@/utils/agentPersistence";
import { loadScriptAgentProgress } from "@/agents/scriptAgent/progress";

const DECISION_MAX_ATTEMPTS = 3;
// 故事骨架/剧本生成为多步骤长任务（读取章节、格式校验重试、超长产出截断续写），放宽到 30 分钟
const SCRIPT_AGENT_REQUEST_TIMEOUT_MS = 1_800_000;
// 半异步：任务与连接解耦——断连不再中止任务，任务在后台持续运行，
// 直到任务完成 / 30 分钟超时 / 用户主动停止 / 同一会话发送新指令。
const runningTasks = new Map<string, AbortController>();

function abortRunningTask(isolationKey: string) {
  const controller = runningTasks.get(isolationKey);
  if (!controller) return false;
  runningTasks.delete(isolationKey);
  controller.abort();
  return true;
}

function createAbortError() {
  const error = new Error("生成已停止");
  error.name = "AbortError";
  return error;
}

async function waitBeforeRetry(delayMs: number, signal?: AbortSignal) {
  if (signal?.aborted) throw createAbortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export default (nsp: Namespace) => {
  nsp.on("connection", async (socket: Socket) => {
    const token = socket.handshake.auth.token;
    const user = await decodeSocketUser(token);
    const projectId = Number(socket.handshake.auth.projectId);
    if (!user || !(await userOwnsProject(user, projectId))) {
      console.log("[scriptAgent] 连接失败，token无效");
      socket.disconnect();
      return;
    }
    const isolationKey = getAgentIsolationKey(user.id, projectId, "scriptAgent");

    // 后台任务仍在运行时重连：任务不打断，前端通过运行记录同步进度
    if (runningTasks.has(isolationKey)) {
      console.log("[scriptAgent] 重连成功，后台任务仍在运行，进度将通过运行记录同步:", socket.id);
    }

    console.log("[scriptAgent] 已连接:", socket.id);

    const resTool = new ResTool(socket, {
      projectId,
    });
    const runtimeRecorder = new ScriptAgentRuntimeRecorder(projectId);
    await runtimeRecorder.load();
    // 进程重启或上次异常退出会留下 running 状态；当前没有活跃任务时标记为已中断，
    // 避免前端重连后误以为后台任务仍在运行（否则会一直轮询一个不存在的任务）。
    if (!runningTasks.has(isolationKey) && runtimeRecorder.isRunning()) {
      // 把"已完成什么、下一步做什么"的确定性结论写进中断状态，
      // 避免前端只看到"上次生成已中断，可继续"而无法判断进度；计算失败则回退通用文案
      let interruptedLabel: string | undefined;
      try {
        interruptedLabel = (await loadScriptAgentProgress(projectId)).conclusive;
      } catch (err) {
        console.warn("[scriptAgent] 中断结论计算失败，回退通用文案:", u.error(err).message);
      }
      runtimeRecorder.markInterrupted(interruptedLabel);
      await runtimeRecorder.flush();
    }
    socket.onAnyOutgoing((event, data) => runtimeRecorder.recordOutgoing(event, data));
    let abortController: AbortController | null = null;

    socket.on("chat", async (data: { content: string }) => {
      const { content } = data;
      resTool.beginWorkflowRequest();
      runtimeRecorder.addUserMessage(content);
      // 新指令发起时，终止本会话所有在跑任务（含断连后在后台继续的旧任务）
      abortController?.abort();
      abortRunningTask(isolationKey);
      abortController = new AbortController();
      const currentController = abortController;
      runningTasks.set(isolationKey, currentController);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        currentController.abort();
      }, SCRIPT_AGENT_REQUEST_TIMEOUT_MS);

      const msg = resTool.newMessage("assistant", "统筹");
      const ctx: agent.AgentContext = {
        socket,
        isolationKey,
        text: content,
        userMessageTime: new Date(msg.datetime).getTime() - 1,
        abortSignal: currentController.signal,
        resTool,
        msg,
      };

      try {
        let currentMsg = ctx.msg;
        let text = currentMsg.text();
        let completed = false;
        let lastError: unknown;

        const syncCurrentMessage = () => {
          if (ctx.msg === currentMsg) return;
          text.complete();
          currentMsg.complete();
          currentMsg = ctx.msg;
          text = currentMsg.text();
        };

        for (let attempt = 1; attempt <= DECISION_MAX_ATTEMPTS; attempt++) {
          let receivedText = false;
          try {
            resTool.workflowStatus("working", attempt === 1 ? "正在分析项目并规划下一步" : "正在重新连接模型服务", "planning");
            const textStream = await agent.decisionAI(ctx);
            for await (const chunk of textStream) {
              await new Promise<void>((resolve) => setTimeout(() => resolve(), 1));
              syncCurrentMessage();
              text.append(chunk);
              receivedText = true;
            }
            completed = true;
            break;
          } catch (err: any) {
            if (timedOut) {
              lastError = new Error(`模型请求超过 ${SCRIPT_AGENT_REQUEST_TIMEOUT_MS / 1000} 秒未响应`);
              break;
            }
            if (err.name === "AbortError" || currentController.signal.aborted) throw err;
            lastError = err;
            const canRetry =
              !receivedText && !resTool.getWorkflowFailure() && agent.isTransientAiError(err) && attempt < DECISION_MAX_ATTEMPTS;
            if (!canRetry) break;
            resTool.workflowStatus("retrying", `模型服务暂时不可用，正在自动重试（${attempt + 1}/${DECISION_MAX_ATTEMPTS}）`, "planning");
            await waitBeforeRetry(750 * attempt, currentController.signal);
          }
        }

        syncCurrentMessage();
        const workflowFailure = resTool.getWorkflowFailure();
        if (completed && !workflowFailure) {
          text.complete();
          currentMsg.complete();
          resTool.workflowStatus("idle", "当前步骤已完成，请查看结果或继续下一阶段");
        } else if (workflowFailure) {
          text.complete();
          currentMsg.complete();
          resTool.workflowStatus("error", workflowFailure.label, workflowFailure.phase);
        } else if (lastError) {
          const errorMsg = u.error(lastError).message;
          text.append(`当前请求未完成：${errorMsg}。请稍后重试，已保存的工作区内容不会丢失。`).complete();
          currentMsg.error(errorMsg);
          resTool.workflowStatus("error", `当前步骤未完成：${errorMsg}`);
        } else {
          text.complete();
          currentMsg.stop();
          resTool.workflowStatus("idle", "已停止当前生成");
        }
      } catch (err: any) {
        if (err.name === "AbortError" || currentController.signal.aborted) {
          ctx.msg.stop();
          if (timedOut) {
            const tip = `本次生成超过 ${SCRIPT_AGENT_REQUEST_TIMEOUT_MS / 60000} 分钟被自动停止，请重试；若内容较长可分步骤生成`;
            ctx.msg.text(tip).complete();
            ctx.msg.error(tip);
            resTool.workflowStatus("error", tip);
          } else {
            resTool.workflowStatus("idle", "已停止当前生成");
          }
        } else {
          const errorMsg = u.error(err).message;
          console.error("[scriptAgent] chat error:", errorMsg);
          ctx.msg.text(errorMsg).complete();
          ctx.msg.error(errorMsg);
          resTool.workflowStatus("error", `当前步骤未完成：${errorMsg}`);
        }
      } finally {
        clearTimeout(timeout);
        if (abortController === currentController) {
          abortController = null;
        }
        // 任务已结束，从运行表移除
        if (runningTasks.get(isolationKey) === currentController) {
          runningTasks.delete(isolationKey);
        }
      }
    });

    socket.on("stop", () => {
      abortController?.abort();
      abortController = null;
      // 重连后的页面点停止，也要能停掉断连期间在后台运行的任务
      abortRunningTask(isolationKey);
    });
    socket.on("disconnect", (reason) => {
      // 半异步：断连不中止任务。任务继续在后台运行，运行记录持续落库；
      // 前端重连后通过 /agents/getRuntime 同步进度，或发送新指令终止旧任务。
      void runtimeRecorder.flush();
      // 记录断连原因（ping timeout / transport close / io server disconnect 等），便于定位断连根因
      console.log(
        `[scriptAgent] 已断开连接（原因: ${reason}，任务${runningTasks.has(isolationKey) ? "继续在后台运行" : "未在运行"}）:`,
        socket.id,
      );
    });
  });
};
