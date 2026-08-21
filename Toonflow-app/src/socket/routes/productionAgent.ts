import { Namespace, Socket } from "socket.io";
import u from "@/utils";
import * as agent from "@/agents/productionAgent";
import ResTool from "@/socket/resTool";
import { decodeSocketUser, userOwnsProject } from "@/middleware/auth";

const DECISION_MAX_ATTEMPTS = 3;

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
    const thinkConfig = { think: false, thinlLevel: 0 };
    console.log("[productionAgent] 已连接:", socket.id, isolationKey);

    socket.on("updateContext", async (data: any, callback?: (response: any) => void) => {
      const projectId = Number(data?.projectId);
      const scriptId = Number(data?.scriptId);
      const script = await u.db("o_script").where({ id: scriptId, projectId }).select("id").first();
      if (!data?.isolationKey || !Number.isFinite(projectId) || !Number.isFinite(scriptId) || !(await userOwnsProject(user, projectId)) || !script) {
        callback?.({ success: false, message: "项目或剧本上下文无效" });
        return;
      }
      isolationKey = `${user.id}:${String(data.isolationKey)}`;
      resTool = new ResTool(socket, { projectId, scriptId });
      callback?.({ success: true });
      console.log("[productionAgent] 上下文已更新:", isolationKey);
    });

    socket.on("chat", async (data: { content?: string }) => {
      const content = String(data?.content || "").trim();
      if (!content) {
        socket.emit("error", { code: "EMPTY_MESSAGE", message: "请输入要执行的内容" });
        return;
      }

      abortController?.abort();
      abortController = new AbortController();
      const currentController = abortController;
      const msg = resTool.newMessage("assistant", "视频策划");
      const ctx: agent.AgentContext = {
        socket,
        isolationKey,
        text: content,
        userMessageTime: new Date(msg.datetime).getTime() - 1,
        abortSignal: currentController.signal,
        resTool,
        msg,
        thinkConfig,
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
        } else {
          ctx.msg.stop();
          resTool.workflowStatus("idle", "已停止当前制作任务");
        }
      } finally {
        if (abortController === currentController) abortController = null;
      }
    });

    socket.on("updateThinkConfig", (data: any) => {
      thinkConfig.think = Boolean(data?.think);
      thinkConfig.thinlLevel = Number(data?.thinlLevel) || 0;
    });

    socket.on("stop", () => {
      abortController?.abort();
      abortController = null;
    });
  });
};
