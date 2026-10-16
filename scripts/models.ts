import { loadModels } from "../src/catalog.ts";

try {
  const models = await loadModels();
  console.table(models.map((m) => ({ id: m.id, name: m.name, context: m.contextWindow, output: m.maxTokens, efforts: m.efforts?.join(", ") ?? "" })));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Model discovery failed.");
  process.exitCode = 1;
}
