import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { chmodSync } from "node:fs";
import { devinCredentialsPath, saveDevinCredentials } from "ns-devin-core";

// Current CLI PKCE exchange (the protocol library still has the older exchange).
const verifier = randomBytes(48).toString("base64url");
const state = randomBytes(24).toString("base64url");
let redirect = "";
let exchanging = false;
let succeed!: () => void;
let fail!: (error: Error) => void;
const complete = new Promise<void>((resolve, reject) => { succeed = resolve; fail = reject; });
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/callback") { response.writeHead(404).end(); return; }
  if (url.searchParams.get("state") !== state) { response.writeHead(400).end("Invalid sign-in state."); return; }
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.has("error")) {
    response.writeHead(400).end("Sign-in was not completed. Return to your terminal.");
    fail(new Error("Devin sign-in was not completed."));
    return;
  }
  if (exchanging) { response.writeHead(409).end("Sign-in is already completing."); return; }
  exchanging = true;
  try {
    const result = await fetch("https://server.codeium.com/exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirect }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!result.ok) throw new Error(`Devin sign-in exchange failed (HTTP ${result.status}).`);
    const body = await result.json() as Record<string, unknown>;
    const token = body.sessionToken ?? body.session_token;
    if (typeof token !== "string" || !token) throw new Error("Devin returned no session token.");
    saveDevinCredentials(token, {
      apiServerUrl: "https://server.codeium.com",
      ...(typeof body.devinApiUrl === "string" ? { devinApiUrl: body.devinApiUrl } : {}),
      ...(typeof body.devinWebappHost === "string" ? { devinWebappHost: body.devinWebappHost } : {}),
    });
    chmodSync(devinCredentialsPath(), 0o600);
    response.writeHead(200, { "content-type": "text/plain" }).end("Signed in to Devin. You can close this tab.");
    succeed();
  } catch (error) {
    response.writeHead(500).end("Sign-in failed. Return to your terminal.");
    fail(error instanceof Error ? error : new Error("Sign-in failed."));
  }
});

try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Couldn't start the login callback.");
  redirect = `http://127.0.0.1:${address.port}/callback`;
  const query = new URLSearchParams({
    redirect_uri: redirect, state, prompt: "select_account", cli_pkce_marker: "1",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  });
  const url = `https://app.devin.ai/auth/cli/continue?${query}`;
  console.log(`Sign in to your Devin subscription:\n\n${url}\n`);
  if (process.platform === "darwin") {
    const child = spawn("open", [url], { stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  }
  const timer = setTimeout(() => fail(new Error("Sign-in timed out after 5 minutes.")), 300_000);
  try { await complete; } finally { clearTimeout(timer); }
  console.log(`Saved Devin login to ${devinCredentialsPath()}. Run \`npm run models\` to verify it.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Devin sign-in failed.");
  process.exitCode = 1;
} finally {
  server.close();
  server.closeAllConnections();
}
