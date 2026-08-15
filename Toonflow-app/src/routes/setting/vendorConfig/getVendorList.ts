import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
const router = express.Router();

function extractVendorMeta(code?: string | null) {
  if (!code) return {};
  const readString = (value?: string) => {
    if (!value) return "";
    try {
      return JSON.parse(`"${value}"`);
    } catch {
      return value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
  };
  const authorMatch = code.match(/author:\s*"((?:\\.|[^"\\])*)"/s);
  const nameMatch = code.match(/name:\s*"((?:\\.|[^"\\])*)"/s);
  const descriptionMatch = code.match(/description:\s*"((?:\\.|[^"\\])*)"/s);
  return {
    author: readString(authorMatch?.[1]),
    name: readString(nameMatch?.[1]),
    description: readString(descriptionMatch?.[1]),
  };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export default router.post("/", async (req, res) => {
  const data = await u.db("o_vendorConfig").select("*");

  const list = data.map((item) => {
    const codeMeta = extractVendorMeta(item.code);
    return {
      ...item,
      author: item.author || codeMeta.author || "",
      name: item.name || codeMeta.name || item.id,
      description: item.description || codeMeta.description || "",
      inputs: parseJson(item.inputs, []),
      inputValues: parseJson(item.inputValues, {}),
      models: parseJson(item.models, []),
    };
  });
  res.status(200).send(success(list));
});
