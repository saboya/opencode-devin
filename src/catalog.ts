import { fetchDevinModelsInProcess, type DevinModelSpec } from "ns-devin-core";
import { requireAuth } from "./auth.ts";

export async function loadModels(): Promise<DevinModelSpec[]> {
  const { apiKey, baseUrl } = requireAuth();
  const models = await fetchDevinModelsInProcess({ apiKey, baseUrl, timeoutMs: 15_000 });
  if (!models?.length) {
    throw new Error("opencode-devin: couldn't load your model catalog. Check your login, API server, and network with `npm run models`.");
  }
  // Fusion orchestrates two agents; exposing only concrete models keeps OpenCode
  // in charge of the agent loop. Adaptive routers are excluded for the same reason.
  return models.filter((m) => !m.isModelRouter && !m.id.startsWith("fusion-"));
}
