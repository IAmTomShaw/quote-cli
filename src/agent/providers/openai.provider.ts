// src/agent/providers/openai.provider.ts

import OpenAI from "openai";
import { EventEmitter } from "events";
import type { AIProvider, AgentMessageReceived } from "./types.js";
import { resolveSettings } from "../../lib/settings.js";
import { fetchPricingFromNotion, convertCurrency, openaiToolsDefinitions } from "../tools.js";
import { PROMPT } from "./constants.js";

const DEBUG_MODE = process.env.DEBUG_MODE === "true";

const DEFAULT_SYSTEM_PROMPT = PROMPT.DEFAULT_SYSTEM_PROMPT;

/**
 * OpenAI implementation of the AIProvider interface
 */
export class OpenAIProvider extends EventEmitter implements AIProvider {
  readonly id = "openai";
  readonly name = "OpenAI";
  
  private client: OpenAI | null = null;
  private messageHistory: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  public session = new EventEmitter();

  constructor() {
    super();
  }

  // Implementation of AIProvider.onMessage
  onMessage(callback: (content: string) => void): void {
    this.on("message", (data: AgentMessageReceived) => {
      if (data.type === "assistant.message") {
        callback(data.content);
      }
    });
  }

  async initialize(): Promise<void> {
    const settings = await resolveSettings();
    const apiKey = (settings as any).openaiApiKey || process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error(
        "OpenAI API key is missing.\n\n" +
        "  Run '/settings' in the CLI to configure it."
      );
    }

    this.client = new OpenAI({ apiKey });
  }

  async startSession(
    brief: string,
    options?: { skipInitialMessage?: boolean }
  ): Promise<void> {
    try {
      if (!this.client) await this.initialize();

      const settings = await resolveSettings();
      const promptToUse = settings.systemPrompt?.trim() ? settings.systemPrompt : DEFAULT_SYSTEM_PROMPT;

      // Initialize the conversation history with the system prompt
      this.messageHistory = [
        { role: "system", content: promptToUse }
      ];

      if (!options?.skipInitialMessage) {
        await this.sendMessage(`Here is the brief for the quote:\n\n${brief}`);
      }
    } catch (error) {
      throw error;
    }
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.client) throw new Error("Client not initialized");

    // Add user message to history
    this.messageHistory.push({ role: "user", content: message });

    try {
      await this.processChatCompletion();
      
      // Signal to the CLI collector that the agent has finished processing
      this.session.emit("session.idle", { type: "session.idle" });
    } catch (error) {
      if (DEBUG_MODE) console.error("[openai] Error generating response:", error);
      this.emit("error", new Error("Failed to communicate with OpenAI"));
    }
  }

  /**
   * Handles the core interaction with OpenAI, including tool calls execution
   */
  private async processChatCompletion(): Promise<void> {
    if (!this.client) return;

    const stream = await this.client.chat.completions.create({
      model: "gpt-5.2-chat-latest",
      messages: this.messageHistory,
      tools: openaiToolsDefinitions,
      stream: true,
    });

    let fullResponse = "";
    const toolCalls: any[] = [];

    // Accumulate chunks from the stream
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      
      if (delta?.content) {
        fullResponse += delta.content;
      }

      // Reconstruct tool calls from streaming chunks
      if (delta?.tool_calls) {
        for (const toolCall of delta.tool_calls) {
          const index = toolCall.index;
          if (!toolCalls[index]) {
            toolCalls[index] = {
              id: toolCall.id,
              type: "function",
              function: { name: toolCall.function?.name || "", arguments: "" }
            };
          }
          if (toolCall.function?.arguments) {
            toolCalls[index].function.arguments += toolCall.function.arguments;
          }
        }
      }
    }

    // Handle tool execution if the model requested it
    if (toolCalls.length > 0) {
      if (DEBUG_MODE) console.log(`[openai] Intercepted ${toolCalls.length} tool calls`);

      // Append the assistant's tool call request to history
      this.messageHistory.push({
        role: "assistant",
        content: fullResponse || null,
        tool_calls: toolCalls
      });

      // Execute each requested tool sequentially
      for (const tc of toolCalls) {
        let toolResult = "";
        
        try {
          if (tc.function.name === "servicePricingLookupTool") {
            toolResult = await fetchPricingFromNotion();
          } else if (tc.function.name === "convert_currency") {
            const args = JSON.parse(tc.function.arguments);
            toolResult = await convertCurrency(args.amount, args.fromCurrency, args.toCurrency);
          } else {
            toolResult = `Error: Unknown function ${tc.function.name}`;
          }
        } catch (err: any) {
          toolResult = `Error executing tool: ${err.message}`;
        }

        // Append the tool's result to history
        this.messageHistory.push({
          role: "tool",
          tool_call_id: tc.id,
          content: toolResult
        });
      }

      // Recursively call the API with the new context containing tool results
      return this.processChatCompletion();
    }

    // If no tools were called, it's a standard text response
    if (fullResponse) {
      this.messageHistory.push({ role: "assistant", content: fullResponse });
      
      this.emit("message", {
        type: "assistant.message",
        content: fullResponse
      } as AgentMessageReceived);
    }
  }

  async endSession(): Promise<void> {
    this.messageHistory = [];
    this.emit("ended");
  }
}