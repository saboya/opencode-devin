import { DEVIN_DEFAULT_BASE_URL, resolveDevinCredentials } from "ns-devin-core";

export interface DevinAuth {
  apiKey: string;
  baseUrl: string;
}

/** Read on every model call, so logging in again doesn't require a service restart. */
export function requireAuth(): DevinAuth {
  const key = process.env.DEVIN_SESSION_TOKEN?.trim() || process.env.WINDSURF_API_KEY?.trim();
  const saved = key ? undefined : resolveDevinCredentials();
  const apiKey = key || saved?.apiKey;
  if (!apiKey) {
    throw new Error(
      "opencode-devin: no Devin login. Run `npm run login` in the plugin directory " +
      "or `devin auth login`, then restart OpenCode. Alternatively set DEVIN_SESSION_TOKEN.",
    );
  }
  if (/^(cog_|apk_)/.test(apiKey)) {
    throw new Error("opencode-devin: a Cloud API key cannot authenticate model inference. Use a Devin CLI session token.");
  }
  const baseUrl = (
    process.env.DEVIN_API_SERVER_URL?.trim() || process.env.WINDSURF_API_SERVER_URL?.trim() ||
    saved?.apiServerUrl || DEVIN_DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
    throw new Error("opencode-devin: API server must use HTTPS (HTTP is allowed for loopback development).");
  }
  return { apiKey, baseUrl };
}
