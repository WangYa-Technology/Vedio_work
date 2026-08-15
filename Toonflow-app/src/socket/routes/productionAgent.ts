import jwt from "jsonwebtoken";
import { Namespace, Socket } from "socket.io";
import u from "@/utils";
import * as agent from "@/agents/productionAgent";
import ResTool from "@/socket/resTool";

async function verifyToken(rawToken: string) {
  const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
  if (!setting?.value || !rawToken) return false;
  try {
    jwt.verify(rawToken.replace("Bearer ", ""), String(setting.value));
    return true;
  } catch {
    return false;
  }
}

export default (nsp: Namespace) => {
  nsp.on("connection", async (socket: Socket) => {
    const auth = socket.handshake.auth;
    if (!auth.token || !(await verifyToken(auth.token))) {
      console.log("[productionAgent] 连接失败，token 无效");
      socket.emit("error", { code: "AUTH_FAILED", message: "登录状态无效，请重新登录" });
      socket.disconnect();
      return;
    }

    let isolationKey = String(auth.isolationKey || "");
    if (!isolationKey) {
      socket.emit("error", { code: "CONTEXT_MISSING", message: "生产 Agent 缺少会话上下文" });
      socket.disconnect();
      return;
    }

    let resTool = new ResTool(socket, {
      projectId: Number(auth.projectId),
      scriptId: auth.scriptId == null ? undefined : Number(auth.scriptId),
    });
    let abortController: AbortController | null = null;
    const thinkConfig = { think: false, thinlLevel: 0 };
    console.log("[productionAgent] 已连接:", socket.id, isolationKey);

    socket.on("updateContext", (data: any, callback?: (response: any) => void) => {
      const projectId = Number(data?.projectId);
      const scriptId = Number(data?.scriptId);
      if (!data?.isolationKey || !Number.isFinite(projectId) || !Number.isFinite(scriptId)) {
        callback?.({ success: false, message: "项目或剧本上下文无效" });
        return;
      }
      isolationKey = String(data.isolationKey);
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
        const textStream = await agent.decisionAI(ctx);
        let currentMsg = ctx.msg;
        let text = currentMsg.text();
        const syncCurrentMessage = () => {
          if (ctx.msg === currentMsg) return;
          text.complete();
          currentMsg.complete();
          currentMsg = ctx.msg;
          text = currentMsg.text();
        };

        let aborted = false;
        try {
          for await (const chunk of textStream) {
            syncCurrentMessage();
            text.append(chunk);
          }
        } catch (error: any) {
          if (error?.name === "AbortError" || currentController.signal.aborted) aborted = true;
          else throw error;
        } finally {
          syncCurrentMessage();
          text.complete();
          if (aborted) currentMsg.stop();
          else currentMsg.complete();
        }
      } catch (error: any) {
        if (error?.name !== "AbortError" && !currentController.signal.aborted) {
          const message = u.error(error).message || "生产 Agent 执行失败";
          console.error("[productionAgent] chat error:", message);
          ctx.msg.text(message).complete();
          ctx.msg.error(message);
          socket.emit("error", { code: "AGENT_ERROR", message });
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
