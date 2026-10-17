import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { create, toBinary, fromBinary, ConnectFrameReader, encodeConnectFrame, devinProto as pb } from "ns-devin-core";

// Offline integration check against an installed OpenCode V2 beta. Every Devin
// request is served by this loopback fixture; no paid credentials are used.
let chats = 0;
const server = createServer(async (req, res) => {
  const reply = (data: Uint8Array) => res.writeHead(200, { "content-type": "application/proto" }).end(data);
  if (req.url?.endsWith("/GetCliModelConfigs")) {
    reply(toBinary(pb.GetCliModelConfigsResponseSchema, create(pb.GetCliModelConfigsResponseSchema, {
      clientModelConfigs: [create(pb.ClientModelConfigSchema, { modelUid: "fixture-model", label: "Fixture Model", maxTokens: 200_000 })],
    })));
  } else if (req.url?.endsWith("/GetUserJwt")) {
    reply(toBinary(pb.GetUserJwtResponseSchema, create(pb.GetUserJwtResponseSchema, { userJwt: "fixture-jwt" })));
  } else if (req.url?.endsWith("/GetChatMessage")) {
    const bytes: Buffer[] = [];
    for await (const chunk of req) bytes.push(Buffer.from(chunk));
    const reader = new ConnectFrameReader(); reader.push(Buffer.concat(bytes));
    const frame = reader.next();
    if (!frame) { res.writeHead(400).end(); return; }
    const request = fromBinary(pb.GetChatMessageRequestSchema, frame.payload);
    assert.equal(request.metadata?.userJwt, "fixture-jwt");
    assert.equal(request.chatModelUid, "fixture-model");
    chats++;
    const message = encodeConnectFrame(toBinary(pb.GetChatMessageResponseSchema, create(pb.GetChatMessageResponseSchema, { deltaText: "pong", stopReason: pb.StopReason.STOP_PATTERN })));
    res.writeHead(200, { "content-type": "application/connect+proto" });
    res.end(Buffer.concat([message, Buffer.from([2, 0, 0, 0, 2]), Buffer.from("{}")]));
  } else { res.writeHead(404).end(); }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const directory = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), "opencode-devin-smoke-"));
try {
  await mkdir(join(directory, ".opencode/plugins"), { recursive: true });
  await writeFile(join(directory, ".opencode/plugins/devin.ts"), `export { default } from ${JSON.stringify(fileURLToPath(new URL("../src/index.ts", import.meta.url)))};\n`);
  await writeFile(join(directory, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", plugins: [] }));
  // OpenCode derives the project location from PWD, so point it at the fixture
  // project instead of inheriting the caller's directory. Isolating the home
  // and XDG directories keeps the user's own plugins and service out of the run.
  const home = join(directory, "home");
  await mkdir(home, { recursive: true });
  const child = spawn(process.env.OPENCODE_BIN ?? "opencode", ["run", "--standalone", "--model", "devin/fixture-model", "Reply with pong."], {
    cwd: directory,
    env: {
      ...process.env,
      PWD: directory,
      OPENCODE: "", OPENCODE_SESSION_ID: "", OPENCODE_TERMINAL: "", AI_AGENT: "",
      HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"),
      DEVIN_SESSION_TOKEN: "devin-session-token$fixture-only", DEVIN_API_SERVER_URL: `http://127.0.0.1:${address.port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(exitCode, 0, output);
    assert.ok(chats > 0, `No request reached the Devin adapter.\n${output}`);
    assert.match(output, /pong/);
    console.log(`OpenCode provider smoke check passed (${chats} fixture inference request(s)).`);
  } finally { clearTimeout(timer); }
} finally {
  server.closeAllConnections();
  server.close();
  await rm(directory, { recursive: true, force: true });
}
