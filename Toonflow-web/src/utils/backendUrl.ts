const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// 开发模式下 Vite 代理转发 WebSocket 长连接偶发断开，直连后端更稳定
const DEV_DIRECT_API_BASE_URL = "http://127.0.0.1:10588/api";

function isLoopback(hostname: string) {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** Resolve the API host from the page host so LAN clients do not call their own localhost. */
export function getDefaultApiBaseUrl() {
  if (typeof window === "undefined") {
    return DEV_DIRECT_API_BASE_URL;
  }

  return `${window.location.origin}/api`;
}

export function resolveApiBaseUrl(value?: string) {
  const fallback = getDefaultApiBaseUrl();
  if (typeof window === "undefined") return value || fallback;

  try {
    const url = new URL(value || fallback, window.location.origin);
    if (!isLoopback(window.location.hostname) && isLoopback(url.hostname)) {
      url.hostname = window.location.hostname;
    }
    if (!url.pathname || url.pathname === "/") url.pathname = "/api";
    let resolved = url.toString().replace(/\/$/, "");
    if (import.meta.env.DEV && isLoopback(window.location.hostname) && isLoopback(url.hostname)) {
      resolved = DEV_DIRECT_API_BASE_URL;
    }
    return resolved;
  } catch {
    return fallback;
  }
}

/** Resolve files served by the backend, such as /skills and /assets. */
export function resolveBackendAssetUrl(value: string, apiBaseUrl?: string) {
  if (!value || /^(?:data:|blob:|https?:\/\/)/i.test(value)) return value;

  try {
    const apiUrl = new URL(resolveApiBaseUrl(apiBaseUrl));
    return new URL(`/${value.replace(/^\/+/, "")}`, apiUrl.origin).toString();
  } catch {
    return value;
  }
}
