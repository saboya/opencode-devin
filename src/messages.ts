import { UnsupportedFunctionalityError, type LanguageModelV3CallOptions, type LanguageModelV3FilePart, type LanguageModelV3ToolResultPart } from "@ai-sdk/provider";
import type { DevinAssistantContent, DevinMessage, DevinTool, DevinUserContent } from "ns-devin-core";

function image(part: LanguageModelV3FilePart): DevinUserContent {
  if (!part.mediaType.startsWith("image/")) {
    throw new UnsupportedFunctionalityError({ functionality: `Devin attachment ${part.mediaType}` });
  }
  let data: string;
  if (part.data instanceof URL) {
    const match = /^data:[^;,]+;base64,(.*)$/s.exec(part.data.href);
    if (!match) throw new UnsupportedFunctionalityError({ functionality: "remote image URLs; supply inline image bytes" });
    data = match[1];
  } else {
    data = typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64");
  }
  return { type: "image", data, mimeType: part.mediaType };
}

function result(part: LanguageModelV3ToolResultPart): DevinMessage {
  const output = part.output;
  let content: DevinUserContent[];
  if (output.type === "content") {
    content = output.value.map((item): DevinUserContent => {
      if (item.type === "text") return { type: "text", text: item.text };
      if (item.type === "image-data") return { type: "image", data: item.data, mimeType: item.mediaType };
      throw new UnsupportedFunctionalityError({ functionality: `Devin tool result ${item.type}` });
    });
  } else {
    const text = output.type === "execution-denied" ? output.reason || "Tool execution denied." :
      typeof output.value === "string" ? output.value : JSON.stringify(output.value);
    content = [{ type: "text", text }];
  }
  return {
    role: "toolResult", toolCallId: part.toolCallId, toolName: part.toolName,
    content, isError: output.type.startsWith("error-") || output.type === "execution-denied",
  };
}

export function convertPrompt(options: LanguageModelV3CallOptions) {
  const system: string[] = [];
  const messages: DevinMessage[] = [];
  for (const message of options.prompt) {
    if (message.role === "system") {
      system.push(message.content);
    } else if (message.role === "user") {
      messages.push({ role: "user", content: message.content.map((p) => p.type === "text" ? { type: "text", text: p.text } : image(p)) });
    } else if (message.role === "assistant") {
      let content: DevinAssistantContent[] = [];
      const flush = () => {
        if (content.length) messages.push({ role: "assistant", content });
        content = [];
      };
      for (const p of message.content) {
        if (p.type === "text") content.push({ type: "text", text: p.text });
        else if (p.type === "reasoning") content.push({ type: "thinking", thinking: p.text });
        else if (p.type === "tool-call") {
          if (!p.input || typeof p.input !== "object" || Array.isArray(p.input)) {
            throw new Error(`opencode-devin: tool ${p.toolName} arguments must be an object.`);
          }
          content.push({ type: "toolCall", id: p.toolCallId, name: p.toolName, arguments: p.input as Record<string, unknown> });
        } else if (p.type === "tool-result") {
          flush();
          messages.push(result(p));
        } else {
          throw new UnsupportedFunctionalityError({ functionality: "Devin assistant file history" });
        }
      }
      flush();
    } else {
      for (const p of message.content) {
        if (p.type !== "tool-result") throw new UnsupportedFunctionalityError({ functionality: "provider-executed tool approvals" });
        messages.push(result(p));
      }
    }
  }
  const tools: DevinTool[] = [];
  if (options.toolChoice?.type === "required" || options.toolChoice?.type === "tool") {
    throw new UnsupportedFunctionalityError({ functionality: "forced Devin tool choice" });
  }
  if (options.toolChoice?.type !== "none") {
    for (const tool of options.tools ?? []) {
      if (tool.type !== "function") throw new UnsupportedFunctionalityError({ functionality: "Devin provider-defined tools" });
      tools.push({ name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema as Record<string, unknown> });
    }
  }
  return { messages, systemPrompt: system, tools };
}
