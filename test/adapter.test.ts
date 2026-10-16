import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { APICallError, type LanguageModelV3CallOptions, type LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { create, toBinary, fromBinary, ConnectFrameReader, encodeConnectFrame, devinProto as pb, DevinStreamError, type DevinModelSpec } from "ns-devin-core";
import { createDevinLanguageModel } from "../src/language.ts";
import { convertPrompt } from "../src/messages.ts";

const spec: DevinModelSpec = {
  id: "test-model", name: "Test model", reasoning: true,
  input: ["text", "image"], contextWindow: 200_000, maxTokens: 4096,
  efforts: ["low", "high"], effortMap: { low: "test-low", high: "test-high" },
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
};
const prompt: LanguageModelV3CallOptions["prompt"] = [
  { role: "system", content: "Use local tools." },
  { role: "user", content: [{ type: "text", text: "Check the directory." }] },
];
const tools: LanguageModelV3CallOptions["tools"] = [{
  type: "function", name: "shell", description: "Run a local command",
  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
}];

test("protobuf wire: auth, effort routing, streaming tool calls, and tool-result continuation", async () => {
  const requests: pb.GetChatMessageRequest[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (req.url?.endsWith("/GetUserJwt")) {
        const auth = fromBinary(pb.GetUserJwtRequestSchema, bytes);
        assert.equal(auth.metadata?.apiKey, "devin-session-token$test-only");
        res.writeHead(200, { "content-type": "application/proto" });
        res.end(toBinary(pb.GetUserJwtResponseSchema, create(pb.GetUserJwtResponseSchema, { userJwt: "test-jwt" })));
        return;
      }
      assert.ok(req.url?.endsWith("/GetChatMessage"));
      const reader = new ConnectFrameReader();
      reader.push(bytes);
      const envelope = reader.next();
      assert.ok(envelope);
      const request = fromBinary(pb.GetChatMessageRequestSchema, envelope.payload);
      requests.push(request);
      assert.equal(request.chatModelUid, "test-high");
      assert.equal(request.metadata?.userJwt, "test-jwt");
      res.writeHead(200, { "content-type": "application/connect+proto" });
      const write = (data: Parameters<typeof pb.GetChatMessageResponseSchema.create>[0]) => {
        res.write(encodeConnectFrame(toBinary(pb.GetChatMessageResponseSchema, create(pb.GetChatMessageResponseSchema, data))));
      };
      if (requests.length === 1) {
        write({ deltaThinking: "I should use shell." });
        write({ deltaText: "Checking." });
        write({ deltaToolCalls: [create(pb.ChatToolCallSchema, { id: "tool-1", name: "shell", argumentsJson: '{"command":' })] });
        write({ deltaToolCalls: [create(pb.ChatToolCallSchema, { id: "tool-1", argumentsJson: '"pwd"}' })] });
        write({ stopReason: pb.StopReason.FUNCTION_CALL, usage: create(pb.ModelUsageStatsSchema, { inputTokens: 10n, outputTokens: 5n, cacheReadTokens: 3n, cacheWriteTokens: 2n }) });
      } else {
        assert.ok(request.chatMessagePrompts.some((p) => p.prompt.includes("/workspace")));
        write({ deltaText: "The directory is /workspace.", stopReason: pb.StopReason.STOP_PATTERN });
      }
      const trailer = Buffer.from("{}");
      const header = Buffer.alloc(5); header[0] = 2; header.writeUInt32BE(trailer.length, 1);
      res.end(Buffer.concat([header, trailer]));
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const model = createDevinLanguageModel(spec, { auth: () => ({ apiKey: "devin-session-token$test-only", baseUrl: `http://127.0.0.1:${address.port}` }) });
  try {
    const options = { prompt, tools, providerOptions: { devin: { effort: "high" } } };
    const response = await model.doStream(options);
    const parts: LanguageModelV3StreamPart[] = [];
    const reader = response.stream.getReader();
    for (;;) { const r = await reader.read(); if (r.done) break; parts.push(r.value); }
    const call = parts.find((p) => p.type === "tool-call");
    assert.ok(call?.type === "tool-call");
    assert.deepEqual(JSON.parse(call.input), { command: "pwd" });
    assert.equal(call.toolName, "shell");
    assert.ok(parts.some((p) => p.type === "reasoning-delta"));
    const finish = parts.find((p) => p.type === "finish");
    assert.ok(finish?.type === "finish");
    assert.equal(finish.finishReason.unified, "tool-calls");
    assert.equal(finish.usage.inputTokens.total, 15);
    const continued = await model.doGenerate({
      ...options,
      prompt: [...prompt,
        { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: "/workspace" } }] },
      ],
    });
    assert.equal(continued.finishReason.unified, "stop");
    assert.deepEqual(continued.content, [{ type: "text", text: "The directory is /workspace." }]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("inline images, structured errors, and disabled tools survive prompt conversion", () => {
  const converted = convertPrompt({
    prompt: [
      { role: "user", content: [{ type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/png" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "x", toolName: "read", output: { type: "error-json", value: { error: "missing" } } }] },
    ], tools, toolChoice: { type: "none" },
  });
  assert.deepEqual(converted.messages[0], { role: "user", content: [{ type: "image", data: "AQID", mimeType: "image/png" }] });
  assert.equal(converted.messages[1].role, "toolResult");
  assert.ok("isError" in converted.messages[1] && converted.messages[1].isError);
  assert.deepEqual(converted.tools, []);
});

test("Connect quota/auth failures preserve status and retryability", async () => {
  for (const [code, status, retryable] of [["unauthenticated", 401, false], ["resource_exhausted", 429, true], ["invalid_argument", 400, false]] as const) {
    const model = createDevinLanguageModel(spec, {
      auth: () => ({ apiKey: "fake", baseUrl: "https://server.codeium.com" }),
      stream: async function* () { throw new DevinStreamError("test failure", code); },
    });
    await assert.rejects(async () => model.doGenerate({ prompt }), (error: unknown) => {
      assert.ok(APICallError.isInstance(error));
      assert.equal(error.statusCode, status);
      assert.equal(error.isRetryable, retryable);
      return true;
    });
  }
});

test("cancelling the SDK stream aborts the underlying request", async () => {
  let signal: AbortSignal | undefined;
  const model = createDevinLanguageModel(spec, {
    auth: () => ({ apiKey: "fake", baseUrl: "https://server.codeium.com" }),
    stream: async function* (request) {
      signal = request.signal;
      yield { type: "start" };
      yield { type: "text_start", index: 0 };
      yield { type: "text_delta", index: 0, delta: "hello" };
    },
  });
  const response = await model.doStream({ prompt });
  const reader = response.stream.getReader();
  await reader.read();
  await reader.read();
  await reader.cancel();
  assert.equal(signal?.aborted, true);
});
