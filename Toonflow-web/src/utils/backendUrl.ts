const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopback(hostname: string) {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** Resolve the API host from the page host so LAN clients do not call their own localhost. */
export function getDefaultApiBaseUrl() {
  if (typeof window === "undefined") {
    return "http://127.0.0.1:10588/api";
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
    return url.toString().replace(/\/$/, "");
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
