import { loadModels } from "../src/catalog.ts";
import { createDevinLanguageModel } from "../src/language.ts";

try {
  const models = await loadModels();
  const id = process.argv[2];
  const model = id ? models.find((m) => m.id === id) : models.find((m) => m.id.startsWith("swe-")) ?? models[0];
  if (!model) throw new Error(`Model ${id} isn't in your account's catalog.`);
  console.log(`Testing devin/${model.id} (one short inference request)`);
  const result = await createDevinLanguageModel(model).doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Reply with only pong." }] }],
    maxOutputTokens: 32, abortSignal: AbortSignal.timeout(60_000),
  });
  console.log(result.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
  console.log(JSON.stringify({ finishReason: result.finishReason, usage: result.usage }));
  if (result.finishReason.unified !== "stop") throw new Error("Probe did not finish normally.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Probe failed.");
  process.exitCode = 1;
}
