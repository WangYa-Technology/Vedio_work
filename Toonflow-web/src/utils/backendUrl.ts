const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopback(hostname: string) {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** Resolve the API host from the page host so LAN clients do not call their own localhost. */
export function getDefaultApiBaseUrl() {
  if (typeof window === "undefined" || !window.location.hostname) return "http://127.0.0.1:10588/api";

  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${window.location.hostname}:10588/api`;
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
