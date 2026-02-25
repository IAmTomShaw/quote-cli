// src/agent/providers/anthropic.provider.ts

import Anthropic from "@anthropic-ai/sdk";
import { EventEmitter } from "events";
import type { AIProvider, AgentMessageReceived } from "./types.js";
import { resolveSettings } from "../../lib/settings.js";
import { fetchPricingFromNotion, convertCurrency } from "../tools.js";
import { PROMPT } from "./constants.js";

const DEBUG_MODE = process.env.DEBUG_MODE === "true";

/**
 * Anthropic Claude implementation of the AIProvider interface
 */
export class AnthropicProvider extends EventEmitter implements AIProvider {
  readonly id = "anthropic";
  readonly name = "Anthropic Claude";
  
  private client: Anthropic | null = null;
  private messageHistory: Anthropic.Messages.MessageParam[] = [];
  public session = new EventEmitter();

  constructor() {
    super();
  }

  onMessage(callback: (content: string) => void): void {
    this.on("message", (data: AgentMessageReceived) => {
      if (data.type === "assistant.message") {
        callback(data.content);
      }
    });
  }

  async initialize(): Promise<void> {
    const settings = await resolveSettings();
    const apiKey = (settings as any).anthropicApiKey || process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error(
        "Anthropic API key is missing.\n\n" +
        "  Run '/settings' in the CLI to configure it."
      );
    }

    this.client = new Anthropic({ apiKey });
  }

  async startSession(brief: string, options?: { skipInitialMessage?: boolean }): Promise<void> {
    try {
      if (!this.client) await this.initialize();
      this.messageHistory = [];

      if (!options?.skipInitialMessage) {
        await this.sendMessage(`Here is the brief for the quote:\n\n${brief}`);
      }
    } catch (error) {
      throw error;
    }
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.client) throw new Error("Client not initialized");

    this.messageHistory.push({ role: "user", content: message });

    try {
      await this.processChat();
      this.session.emit("session.idle", { type: "session.idle" });
    } catch (error) {
      if (DEBUG_MODE) console.error("[anthropic] Error:", error);
      throw error;
    }
  }

  private async processChat(): Promise<void> {
    if (!this.client) return;

    const settings = await resolveSettings();
    const systemPrompt = settings.systemPrompt?.trim() ? settings.systemPrompt : PROMPT.DEFAULT_SYSTEM_PROMPT;

    // Define tools in Anthropic format
    const anthropicTools: Anthropic.Messages.Tool[] = [
      {
        name: "servicePricingLookupTool",
        description: "Retrieve the service pricing list from Notion in the form of plain text.",
        input_schema: { type: "object", properties: {} }
      },
      {
        name: "convert_currency",
        description: "Convert an amount from one currency to another.",
        input_schema: {
          type: "object",
          properties: {
            amount: { type: "number" },
            fromCurrency: { type: "string" },
            toCurrency: { type: "string" }
          },
          required: ["amount", "fromCurrency", "toCurrency"]
        }
      }
    ];

    const response = await this.client.messages.create({
      model: "claude-4.6-20240924",
      max_tokens: 4096,
      system: systemPrompt,
      messages: this.messageHistory,
      tools: anthropicTools
    });

    const toolCalls = response.content.filter(c => c.type === "tool_use") as Anthropic.Messages.ToolUseBlock[];
    const textBlocks = response.content.filter(c => c.type === "text") as Anthropic.Messages.TextBlock[];

    // Handle text response
    if (textBlocks.length > 0) {
      const fullText = textBlocks.map(t => t.text).join("\n");
      this.messageHistory.push({ role: "assistant", content: response.content });
      
      this.emit("message", {
        type: "assistant.message",
        content: fullText
      } as AgentMessageReceived);
    }

    // Handle tool calls
    if (toolCalls.length > 0) {
      if (DEBUG_MODE) console.log(`[anthropic] Executing ${toolCalls.length} tools`);

      // If we only had tool calls and no text, we still need to add the assistant message to history
      if (textBlocks.length === 0) {
        this.messageHistory.push({ role: "assistant", content: response.content });
      }

      for (const tc of toolCalls) {
        let result = "";
        try {
          if (tc.name === "servicePricingLookupTool") {
            result = await fetchPricingFromNotion();
          } else if (tc.name === "convert_currency") {
            const { amount, fromCurrency, toCurrency } = tc.input as any;
            result = await convertCurrency(amount, fromCurrency, toCurrency);
          }
        } catch (err: any) {
          result = `Error: ${err.message}`;
        }

        this.messageHistory.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: tc.id,
              content: result
            }
          ]
        });
      }

      // Recursive call to get the final response after tool results
      return this.processChat();
    }
  }

  async endSession(): Promise<void> {
    this.messageHistory = [];
    this.emit("ended");
  }
}