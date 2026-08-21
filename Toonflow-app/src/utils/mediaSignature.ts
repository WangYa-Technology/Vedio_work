import { createHmac, timingSafeEqual } from "node:crypto";

export function signMediaPath(pathname: string, expires: number, secret: string) {
  return createHmac("sha256", secret).update(`${pathname}:${expires}`).digest("hex");
}

export function verifyMediaSignature(pathname: string, expiresValue: unknown, signatureValue: unknown, secret: string) {
  const expires = Number(expiresValue);
  const signature = String(signatureValue || "");
  if (!Number.isSafeInteger(expires) || expires < Date.now() || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = signMediaPath(pathname, expires, secret);
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
