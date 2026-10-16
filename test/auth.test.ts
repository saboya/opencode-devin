import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireAuth } from "../src/auth.ts";

test("credential precedence, rotation, and server selection never modify the CLI store", () => {
  const keys = ["DEVIN_SESSION_TOKEN", "WINDSURF_API_KEY", "DEVIN_CREDENTIALS_PATH", "DEVIN_API_SERVER_URL", "WINDSURF_API_SERVER_URL"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const directory = mkdtempSync(join(tmpdir(), "devin-auth-test-"));
  const path = join(directory, "credentials.toml");
  try {
    for (const key of keys) delete process.env[key];
    process.env.DEVIN_CREDENTIALS_PATH = path;
    assert.throws(requireAuth, /no Devin login/);
    const body = 'windsurf_api_key = "devin-session-token$first"\napi_server_url = "https://example.test/"\n';
    writeFileSync(path, body);
    assert.deepEqual(requireAuth(), { apiKey: "devin-session-token$first", baseUrl: "https://example.test" });
    assert.equal(readFileSync(path, "utf8"), body);
    writeFileSync(path, body.replace("$first", "$second"));
    assert.equal(requireAuth().apiKey, "devin-session-token$second");
    process.env.WINDSURF_API_KEY = "legacy-env-key";
    assert.equal(requireAuth().apiKey, "legacy-env-key");
    // Explicit environment tokens use the default server, not another saved account's server.
    assert.equal(requireAuth().baseUrl, "https://server.codeium.com");
    process.env.DEVIN_SESSION_TOKEN = "session-env-key";
    assert.equal(requireAuth().apiKey, "session-env-key");
    process.env.DEVIN_API_SERVER_URL = "http://127.0.0.1:1234/";
    assert.equal(requireAuth().baseUrl, "http://127.0.0.1:1234");
    process.env.DEVIN_API_SERVER_URL = "http://remote.example";
    assert.throws(requireAuth, /must use HTTPS/);
    process.env.DEVIN_SESSION_TOKEN = "cog_cloud-key";
    assert.throws(requireAuth, /Cloud API key/);
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
