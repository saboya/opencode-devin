import { Model, Plugin, Provider } from "@opencode/plugin";
import type { DevinModelSpec } from "ns-devin-core";
import { loadModels } from "./catalog.ts";
import { createDevinLanguageModel } from "./language.ts";
import { registerFreeTitles } from "./titles.ts";

const PROVIDER_ID = "devin";
const providerID = Provider.ID.make(PROVIDER_ID);

export function toModel(spec: DevinModelSpec): Model.Info {
  const defaults = Model.Info.default(providerID, Model.ID.make(spec.id));
  return {
    ...defaults,
    name: spec.name,
    capabilities: { tools: spec.supportsTools !== false, input: spec.input, output: ["text"] },
    limit: { context: spec.contextWindow, output: spec.maxTokens },
    variants: (spec.efforts ?? []).map((effort) => ({
      id: Model.VariantID.make(effort), settings: { devin: { effort } },
    })),
    cost: [{
      input: spec.cost.input as Model.Cost["input"], output: spec.cost.output as Model.Cost["output"],
      cache: { read: spec.cost.cacheRead as Model.Cost["cache"]["read"], write: spec.cost.cacheWrite as Model.Cost["cache"]["write"] },
    }],
  };
}

export default Plugin.define({
  id: "opencode-devin",
  async setup(ctx) {
    const models = await loadModels();
    const byID = new Map(models.map((model) => [model.id, model]));
    const languageModel = (id: string) => {
      const spec = byID.get(id);
      if (!spec) throw new Error(`opencode-devin: unknown model ${id}. Restart OpenCode to refresh the catalog.`);
      return createDevinLanguageModel(spec);
    };
    const registrations: Array<{ dispose(): Promise<void> }> = [];
    try {
      registrations.push(await registerFreeTitles(ctx));
      // V2 registers providers/models through ctx.provider; the aisdk hooks
      // below supply the transport for the "devin" provider.
      registrations.push(await ctx.aisdk.hook("sdk", (event) => {
        event.sdk = { languageModel };
      }, { providerID: PROVIDER_ID }));
      registrations.push(await ctx.aisdk.hook("language", (event) => {
        event.language = languageModel(event.model.modelID);
      }, { providerID: PROVIDER_ID }));
      registrations.push(await ctx.provider.transform((editor) => {
        editor.add({
          info: {
            ...Provider.Info.empty(providerID), name: "Devin", activation: "enabled",
            // The sdk/language hooks replace this transport. No credentials are
            // copied into provider state or sent through the OpenAI protocol.
            package: "aisdk:@ai-sdk/openai-compatible",
          },
          models: models.map((spec) => toModel(spec)),
        });
      }));
    } catch (error) {
      for (const registration of registrations.reverse()) await registration.dispose();
      throw error;
    }
    return async () => {
      for (const registration of registrations.reverse()) await registration.dispose();
    };
  },
});
