import { Namespace, Socket } from "socket.io";
import u from "@/utils";
import * as agent from "@/agents/scriptAgent/index";
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
    const token = socket.handshake.auth.token;
    const user = await decodeSocketUser(token);
    const projectId = Number(socket.handshake.auth.projectId);
    if (!user || !(await userOwnsProject(user, projectId))) {
      console.log("[scriptAgent] 连接失败，token无效");
      socket.disconnect();
      return;
    }
    const isolationKey = `${user.id}:${String(socket.handshake.auth.isolationKey || "")}`;
    if (!isolationKey) {
      console.log("[scriptAgent] 连接失败，缺少 isolationKey");
      socket.disconnect();
      return;
    }

    console.log("[scriptAgent] 已连接:", socket.id);

    const resTool = new ResTool(socket, {
      projectId,
    });
    let abortController: AbortController | null = null;

    socket.on("chat", async (data: { content: string }) => {
      const { content } = data;
      abortController?.abort();
      abortController = new AbortController();
      const currentController = abortController;

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
            if (err.name === "AbortError" || currentController.signal.aborted) throw err;
            lastError = err;
            const canRetry = !receivedText && agent.isTransientAiError(err) && attempt < DECISION_MAX_ATTEMPTS;
            if (!canRetry) break;
            resTool.workflowStatus("retrying", `模型服务暂时不可用，正在自动重试（${attempt + 1}/${DECISION_MAX_ATTEMPTS}）`, "planning");
            await waitBeforeRetry(750 * attempt, currentController.signal);
          }
        }

        syncCurrentMessage();
        if (completed) {
          text.complete();
          currentMsg.complete();
          resTool.workflowStatus("idle", "当前步骤已完成，请查看结果或继续下一阶段");
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
          resTool.workflowStatus("idle", "已停止当前生成");
        } else {
          const errorMsg = u.error(err).message;
          console.error("[scriptAgent] chat error:", errorMsg);
          ctx.msg.text(errorMsg).complete();
          ctx.msg.error(errorMsg);
          resTool.workflowStatus("error", `当前步骤未完成：${errorMsg}`);
        }
      } finally {
        if (abortController === currentController) {
          abortController = null;
        }
      }
    });

    socket.on("stop", () => {
      abortController?.abort();
      abortController = null;
    });
  });
  nsp.on("disconnect", (socket: Socket) => {
    console.log("[scriptAgent] 已断开连接:", socket.id);
  });
};
