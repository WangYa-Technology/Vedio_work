import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import u from "@/utils";
import { error } from "@/lib/responseFormat";
import { verifyMediaSignature } from "@/utils/mediaSignature";

export interface AuthUser {
  id: number;
  name: string;
  role: "admin" | "user";
}

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

function bearerToken(req: Request) {
  return String(req.headers.authorization || req.query.token || "").replace(/^Bearer\s+/i, "");
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/api/login/login" || req.path === "/api/login/register" || req.path.startsWith("/skills/")) return next();
  if (req.path.startsWith("/oss/")) {
    const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
    if (setting?.value && verifyMediaSignature(req.path, req.query.expires, req.query.signature, String(setting.value))) return next();
  }
  const token = bearerToken(req);
  if (!token) return res.status(401).send(error("未提供登录凭证"));
  const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
  if (!setting?.value) return res.status(500).send(error("服务器密钥未配置"));
  try {
    const payload = jwt.verify(token, String(setting.value)) as { id?: unknown };
    const userId = Number(payload.id);
    const user = await u.db("o_user").where({ id: userId }).select("id", "name", "role", "status").first();
    if (!user || user.status === "disabled") return res.status(401).send(error("账号不存在或已停用"));
    req.authUser = { id: Number(user.id), name: String(user.name), role: "admin" };
    next();
  } catch {
    return res.status(401).send(error("登录状态无效，请重新登录"));
  }
}

export async function decodeSocketUser(rawToken: string): Promise<AuthUser | null> {
  if (!rawToken) return null;
  const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
  if (!setting?.value) return null;
  try {
    const payload = jwt.verify(rawToken.replace(/^Bearer\s+/i, ""), String(setting.value)) as { id?: unknown };
    const user = await u.db("o_user").where({ id: Number(payload.id) }).select("id", "name", "role", "status").first();
    if (!user || user.status === "disabled") return null;
    return { id: Number(user.id), name: String(user.name), role: "admin" };
  } catch {
    return null;
  }
}

export async function userOwnsProject(user: AuthUser, projectId: number) {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) return false;
  return Boolean(await u.db("o_project").where({ id: projectId, userId: user.id }).select("id").first());
}

const idResourceByPath: Array<[RegExp, string, string]> = [
  [/\/(?:project\/(?:editProject|delProject)|general\/(?:getSingleProject|updateProject))/, "o_project", "id"],
  [/\/script\/(?:updateScript|delScript|exportScript|pollScriptAssets)/, "o_script", "id"],
  [/\/novel\/(?:updateNovel|delNovel|getNovelData|getNovelEventState|batchDeleteNovel)/, "o_novel", "id"],
  [/\/assets\/(?:updateAssets|delAssets|batchDelete|getImage|pollingImageAssets|pollingPromptAssets)/, "o_assets", "id"],
  [/\/assetsGenerate\/cancelGenerate/, "o_tasks", "id"],
  [/\/production\/workbench\/(?:delVideo)/, "o_video", "id"],
  [/\/production\/workbench\/(?:deleteTrack)/, "o_videoTrack", "id"],
  [/\/task\/taskDetails/, "o_tasks", "taskId"],
];

async function projectIdsForResource(table: string, field: string, raw: unknown) {
  const ids = (Array.isArray(raw) ? raw : [raw]).map(Number).filter(Number.isSafeInteger);
  if (!ids.length) return [];
  if (table === "o_project") return ids;
  if (table === "o_image") {
    const rows = await u.db("o_image").join("o_assets", "o_image.assetsId", "o_assets.id").whereIn(`o_image.${field}`, ids).select("o_assets.projectId");
    return rows.map((row: any) => Number(row.projectId));
  }
  if (table === "o_event") {
    const rows = await u.db("o_event")
      .join("o_eventChapter", "o_event.id", "o_eventChapter.eventId")
      .join("o_novel", "o_eventChapter.novelId", "o_novel.id")
      .whereIn(`o_event.${field}`, ids)
      .select("o_novel.projectId");
    return rows.map((row: any) => Number(row.projectId));
  }
  const rows = await (u.db as any)(table).whereIn(field, ids).select("projectId");
  return rows.map((row: any) => Number(row.projectId));
}

const adminMutationPaths = /^\/api\/(?:setting\/(?:vendorConfig|agentDeploy|dbConfig|skillManagement|promptManage|contentSafety|dev)|project\/(?:add|edit|delete)(?:VisualManual|DirectorManual)|artStyle\/)/;

export async function authorizeRequest(req: Request, res: Response, next: NextFunction) {
  const user = req.authUser;
  if (!user || req.path === "/api/login/login") return next();
  const body = (req.body || {}) as Record<string, unknown>;
  const query = req.query as Record<string, unknown>;
  const projectIds = new Set<number>();
  for (const raw of [body.projectId, query.projectId]) {
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0) projectIds.add(value);
  }

  const resourceFields: Array<[string, string, unknown]> = [
    ["o_script", "id", body.scriptId ?? body.episodesId],
    ["o_assets", "id", body.assetsId ?? body.roleAssetId],
    ["o_storyboard", "id", body.storyboardId ?? body.storyboardIds],
    ["o_video", "id", body.videoId],
    ["o_videoTrack", "id", body.trackId],
    ["o_image", "id", body.imageId],
    ["o_tasks", "id", body.taskId],
  ];
  if (/\/novel\/event\/(?:deletEvent|batchDeleteEvent)/.test(req.path)) resourceFields.push(["o_event", "id", body.id ?? body.ids]);
  if (/\/assets\/delImage/.test(req.path)) resourceFields.push(["o_image", "id", body.id]);
  const routeMapping = idResourceByPath.find(([pattern]) => pattern.test(req.path));
  if (routeMapping) resourceFields.push([routeMapping[1], "id", body[routeMapping[2]] ?? body.ids]);

  for (const [table, field, raw] of resourceFields) {
    for (const projectId of await projectIdsForResource(table, field, raw)) projectIds.add(projectId);
  }
  for (const projectId of projectIds) {
    if (!(await userOwnsProject(user, projectId))) return res.status(403).send(error("无权访问该项目"));
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  next();
}
