import {
  APICallError, UnsupportedFunctionalityError,
  type LanguageModelV3, type LanguageModelV3CallOptions, type LanguageModelV3Content,
  type LanguageModelV3FinishReason, type LanguageModelV3GenerateResult,
  type LanguageModelV3StreamPart, type LanguageModelV3Usage, type SharedV3Warning,
} from "@ai-sdk/provider";
import {
  DevinApiError, DevinStreamError, isDevinAuthError, isDevinContextOverflowError,
  isDevinRateLimitError, streamDevinInProcess,
  type DevinEffort, type DevinModelSpec, type DevinStreamRequest, type DevinUsage,
} from "ns-devin-core";
import { requireAuth, type DevinAuth } from "./auth.ts";
import { convertPrompt } from "./messages.ts";

type StreamFn = typeof streamDevinInProcess;

function usage(value?: DevinUsage): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: value ? value.input + (value.cacheRead ?? 0) + (value.cacheWrite ?? 0) : undefined,
      noCache: value?.input, cacheRead: value?.cacheRead, cacheWrite: value?.cacheWrite,
    },
    outputTokens: { total: value?.output, text: undefined, reasoning: undefined },
  };
}

function apiError(error: unknown, baseUrl: string): unknown {
  if (!(error instanceof DevinApiError) && !(error instanceof DevinStreamError)) return error;
  const status = isDevinAuthError(error) ? 401 : isDevinRateLimitError(error) ? 429 :
    isDevinContextOverflowError(error) ? 400 : error instanceof DevinApiError ? error.status :
    error.code === "invalid_argument" ? 400 : error.code === "unavailable" ? 503 : 502;
  return new APICallError({
    message: status === 401 ? "Devin login was refused. Run `npm run login` or `devin auth login` again." : error.message,
    url: baseUrl, requestBodyValues: {}, statusCode: status,
    responseHeaders: error instanceof DevinApiError ? error.headers : undefined,
    isRetryable: status === 429 || status >= 500, cause: error,
  });
}

/** Native AI SDK model: all tools are returned to, and executed by, OpenCode. */
export function createDevinLanguageModel(
  spec: DevinModelSpec,
  dependencies: { auth?: () => DevinAuth; stream?: StreamFn } = {},
): LanguageModelV3 {
  const auth = dependencies.auth ?? requireAuth;
  const run = dependencies.stream ?? streamDevinInProcess;
  return {
    specificationVersion: "v3", provider: "devin", modelId: spec.id, supportedUrls: {},
    async doStream(options) {
      const credentials = auth();
      const warnings: SharedV3Warning[] = [];
      for (const key of ["topK", "presencePenalty", "frequencyPenalty", "seed"] as const) {
        if (options[key] !== undefined) warnings.push({ type: "unsupported", feature: key });
      }
      if (options.responseFormat?.type === "json") throw new UnsupportedFunctionalityError({ functionality: "Devin JSON response format" });
      const effort = options.providerOptions?.devin?.effort;
      if (effort !== undefined && (typeof effort !== "string" || !spec.efforts?.includes(effort as DevinEffort))) {
        throw new Error(`opencode-devin: unsupported effort ${String(effort)} for ${spec.id}.`);
      }
      const controller = new AbortController();
      const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, controller.signal]) : controller.signal;
      const request: DevinStreamRequest = {
        ...convertPrompt(options),
        model: { ...spec, baseUrl: credentials.baseUrl }, apiKey: credentials.apiKey, signal,
        maxTokens: options.maxOutputTokens, temperature: options.temperature, topP: options.topP,
        stopSequences: options.stopSequences, effort: effort as DevinEffort | undefined,
      };
      async function* parts(): AsyncGenerator<LanguageModelV3StreamPart> {
        yield { type: "stream-start", warnings };
        let used: DevinUsage | undefined;
        let finished = false;
        for await (const event of run(request)) {
          switch (event.type) {
            case "start": break;
            case "text_start": yield { type: "text-start", id: String(event.index) }; break;
            case "text_delta": yield { type: "text-delta", id: String(event.index), delta: event.delta }; break;
            case "text_end": yield { type: "text-end", id: String(event.index) }; break;
            case "thinking_start": yield { type: "reasoning-start", id: String(event.index) }; break;
            case "thinking_delta": yield { type: "reasoning-delta", id: String(event.index), delta: event.delta }; break;
            case "thinking_end": yield { type: "reasoning-end", id: String(event.index) }; break;
            case "tool_call_start": yield { type: "tool-input-start", id: event.id, toolName: event.name }; break;
            case "tool_call_delta": yield { type: "tool-input-delta", id: event.id, delta: event.argumentsDelta }; break;
            case "tool_call_end":
              yield { type: "tool-input-end", id: event.id };
              yield { type: "tool-call", toolCallId: event.id, toolName: event.name, input: event.argumentsJson };
              break;
            case "usage": used = event.usage; break;
            case "reset": throw new Error("Devin reset a partially streamed response. Retry the turn.");
            case "done": {
              if (event.errorMessage) throw new Error(event.errorMessage);
              finished = true;
              if (event.responseId) yield { type: "response-metadata", id: event.responseId, modelId: event.upstreamModel ?? spec.id };
              yield {
                type: "finish", usage: usage(used),
                finishReason: { unified: event.stopReason === "toolUse" ? "tool-calls" : event.stopReason, raw: event.stopReason },
              };
              break;
            }
          }
        }
        if (!finished) throw new Error("Devin's response ended without a completion marker.");
      }
      const iterator = parts();
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          async pull(output) {
            try {
              const next = await iterator.next();
              if (next.done) output.close();
              else output.enqueue(next.value);
            } catch (error) {
              controller.abort();
              output.error(apiError(error, credentials.baseUrl));
            }
          },
          async cancel() {
            controller.abort();
            await iterator.return(undefined);
          },
        }),
      };
    },
    async doGenerate(options): Promise<LanguageModelV3GenerateResult> {
      const { stream } = await this.doStream(options);
      const content: LanguageModelV3Content[] = [];
      const blocks = new Map<string, { type: "text" | "reasoning"; text: string }>();
      let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined };
      let used = usage();
      let warnings: SharedV3Warning[] = [];
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value: part } = await reader.read();
          if (done) break;
          if (part.type === "stream-start") warnings = part.warnings;
          if (part.type === "text-start" || part.type === "reasoning-start") {
            const block = { type: part.type === "text-start" ? "text" as const : "reasoning" as const, text: "" };
            blocks.set(part.id, block);
            content.push(block);
          } else if (part.type === "text-delta" || part.type === "reasoning-delta") {
            const block = blocks.get(part.id);
            if (block) block.text += part.delta;
          } else if (part.type === "tool-call") content.push(part);
          else if (part.type === "finish") { finishReason = part.finishReason; used = part.usage; }
        }
      } finally {
        reader.releaseLock();
      }
      return { content, finishReason, usage: used, warnings };
    },
  };
}
