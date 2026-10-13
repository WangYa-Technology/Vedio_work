import { Namespace, Socket } from "socket.io";
import u from "@/utils";
import * as agent from "@/agents/productionAgent";
import ResTool from "@/socket/resTool";
import { decodeSocketUser, userOwnsProject } from "@/middleware/auth";
import { ProductionAgentRuntimeRecorder } from "@/utils/agentPersistence";
import { beginAgentTask, endAgentTask } from "@/utils/agentTaskGuard";

const DECISION_MAX_ATTEMPTS = 3;
// 分镜生成为长任务（整集拆镜 + 一次性输出完整分镜表 XML），兜底超时放宽到 30 分钟；
// 该超时仅用于防止任务悬挂，不是等待上限。
const PRODUCTION_AGENT_REQUEST_TIMEOUT_MS = 1_800_000;
// 半异步：任务与连接解耦——断连不再中止任务，任务在后台持续运行，
// 直到任务完成 / 30 分钟兜底超时 / 用户主动停止 / 同一会话发送新指令。
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
    const auth = socket.handshake.auth;
    const user = await decodeSocketUser(auth.token);
    const initialProjectId = Number(auth.projectId);
    const initialScript = auth.scriptId == null ? true : Boolean(await u.db("o_script").where({ id: Number(auth.scriptId), projectId: initialProjectId }).select("id").first());
    if (!user || !(await userOwnsProject(user, initialProjectId)) || !initialScript) {
      console.log("[productionAgent] 连接失败，token 无效");
      socket.emit("error", { code: "AUTH_FAILED", message: "登录状态无效，请重新登录" });
      socket.disconnect();
      return;
    }

    let isolationKey = `${user.id}:${String(auth.isolationKey || "")}`;
    if (!isolationKey) {
      socket.emit("error", { code: "CONTEXT_MISSING", message: "生产 Agent 缺少会话上下文" });
      socket.disconnect();
      return;
    }

    let resTool = new ResTool(socket, {
      projectId: initialProjectId,
      scriptId: auth.scriptId == null ? undefined : Number(auth.scriptId),
    });
    let abortController: AbortController | null = null;
    const initialScriptId = Number(auth.scriptId);
    let runtimeRecorder = new ProductionAgentRuntimeRecorder(
      initialProjectId,
      Number.isSafeInteger(initialScriptId) && initialScriptId > 0 ? initialScriptId : 0,
    );
    await runtimeRecorder.load();
    socket.onAnyOutgoing((event, data) => runtimeRecorder.recordOutgoing(event, data));
    // 进程重启或上次异常退出会留下 running 状态；当前没有活跃任务时标记为已中断，
    // 避免前端重连后误以为后台任务仍在运行。
    if (!runningTasks.has(isolationKey) && runtimeRecorder.isRunning()) {
      runtimeRecorder.markInterrupted();
      await runtimeRecorder.flush();
    }
    console.log("[productionAgent] 已连接:", socket.id, isolationKey);
    // 后台任务仍在运行时重连：任务不打断，前端通过运行记录同步进度
    if (runningTasks.has(isolationKey)) {
      console.log("[productionAgent] 重连成功，后台任务仍在运行，进度将通过运行记录同步:", socket.id);
    }

    socket.on("updateContext", async (data: any, callback?: (response: any) => void) => {
      const projectId = Number(data?.projectId);
      const scriptId = Number(data?.scriptId);
      const script = await u.db("o_script").where({ id: scriptId, projectId }).select("id").first();
      if (!data?.isolationKey || !Number.isFinite(projectId) || !Number.isFinite(scriptId) || !(await userOwnsProject(user, projectId)) || !script) {
        callback?.({ success: false, message: "项目或剧本上下文无效" });
        return;
      }
      const nextIsolationKey = `${user.id}:${String(data.isolationKey)}`;
      // 用户明确切换剧集上下文时，中止本会话正在运行的任务（含断连后遗留的后台任务），
      // 避免其后续输出写入新剧集的运行记录；断连重连不算切换，不会触发中止。
      if (nextIsolationKey !== isolationKey) abortRunningTask(isolationKey);
      isolationKey = nextIsolationKey;
      resTool = new ResTool(socket, { projectId, scriptId });
      runtimeRecorder = new ProductionAgentRuntimeRecorder(projectId, scriptId);
      await runtimeRecorder.load();
      if (!runningTasks.has(isolationKey) && runtimeRecorder.isRunning()) {
        runtimeRecorder.markInterrupted();
        await runtimeRecorder.flush();
      }
      callback?.({ success: true });
      console.log("[productionAgent] 上下文已更新:", isolationKey);
    });

    socket.on("chat", async (data: { content?: string }) => {
      const content = String(data?.content || "").trim();
      if (!content) {
        socket.emit("error", { code: "EMPTY_MESSAGE", message: "请输入要执行的内容" });
        return;
      }

      // 新指令发起时，终止本会话所有在跑任务（含断连后在后台继续的旧任务），避免并发写入同一份工作区产物
      abortController?.abort();
      abortRunningTask(isolationKey);
      abortController = new AbortController();
      const currentController = abortController;
      // taskKey 必须快照：updateContext 会改写 isolationKey，任务归属以启动时为准
      const taskKey = isolationKey;
      const taskGeneration = beginAgentTask(taskKey);
      runningTasks.set(taskKey, currentController);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        currentController.abort();
      }, PRODUCTION_AGENT_REQUEST_TIMEOUT_MS);

      runtimeRecorder.addUserMessage(content);
      const msg = resTool.newMessage("assistant", "视频策划");
      const ctx: agent.AgentContext = {
        socket,
        isolationKey: taskKey,
        text: content,
        userMessageTime: new Date(msg.datetime).getTime() - 1,
        abortSignal: currentController.signal,
        resTool,
        msg,
        taskGeneration,
      };

      try {
        let currentMsg = ctx.msg;
        let text = currentMsg.text();
        const syncCurrentMessage = () => {
          if (ctx.msg === currentMsg) return;
          text.complete();
          currentMsg.complete();
          currentMsg = ctx.msg;
          text = currentMsg.text();
        };

        let completed = false;
        let lastError: unknown;
        for (let attempt = 1; attempt <= DECISION_MAX_ATTEMPTS; attempt++) {
          let receivedText = false;
          try {
            resTool.workflowStatus("working", attempt === 1 ? "正在分析制作进度并规划下一步" : "正在重新连接制作 Agent", "planning");
            const textStream = await agent.decisionAI(ctx);
            for await (const chunk of textStream) {
              syncCurrentMessage();
              text.append(chunk);
              receivedText = true;
            }
            completed = true;
            break;
          } catch (error: any) {
            if (error?.name === "AbortError" || currentController.signal.aborted) throw error;
            lastError = error;
            const canRetry = !receivedText && agent.isTransientAiError(error) && attempt < DECISION_MAX_ATTEMPTS;
            if (!canRetry) break;
            resTool.workflowStatus("retrying", `制作 Agent 暂时不可用，正在自动重试（${attempt + 1}/${DECISION_MAX_ATTEMPTS}）`, "planning");
            await waitBeforeRetry(750 * attempt, currentController.signal);
          }
        }

        syncCurrentMessage();
        if (completed) {
          text.complete();
          currentMsg.complete();
          resTool.workflowStatus("idle", "当前制作步骤已完成，请查看工作台或继续下一阶段");
        } else if (lastError) {
          const errorMessage = u.error(lastError).message;
          text.append(`当前制作步骤未完成：${errorMessage}。已保存的制作数据不会丢失，请点击重试或继续当前步骤。`).complete();
          currentMsg.error(errorMessage);
          resTool.workflowStatus("error", `当前制作步骤未完成：${errorMessage}`, "planning");
        } else {
          text.complete();
          currentMsg.stop();
          resTool.workflowStatus("idle", "已停止当前制作任务");
        }
      } catch (error: any) {
        if (error?.name !== "AbortError" && !currentController.signal.aborted) {
          const message = u.error(error).message || "生产 Agent 执行失败";
          console.error("[productionAgent] chat error:", message);
          ctx.msg.text(message).complete();
          ctx.msg.error(message);
          socket.emit("error", { code: "AGENT_ERROR", message });
          resTool.workflowStatus("error", `当前制作步骤未完成：${message}`, "production");
        } else if (timedOut) {
          const tip = `本次生成超过 ${PRODUCTION_AGENT_REQUEST_TIMEOUT_MS / 60000} 分钟被自动停止，请重试；若内容较长可分步生成`;
          ctx.msg.stop();
          ctx.msg.text(tip).complete();
          ctx.msg.error(tip);
          resTool.workflowStatus("error", tip, "production");
        } else {
          ctx.msg.stop();
          resTool.workflowStatus("idle", "已停止当前制作任务");
        }
      } finally {
        clearTimeout(timeout);
        if (abortController === currentController) abortController = null;
        if (runningTasks.get(taskKey) === currentController) runningTasks.delete(taskKey);
        endAgentTask(taskKey, taskGeneration);
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
        `[productionAgent] 已断开连接（原因: ${reason}，任务${runningTasks.has(isolationKey) ? "继续在后台运行" : "未在运行"}）:`,
        socket.id,
      );
    });
  });
};
