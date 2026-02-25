import { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { EventEmitter } from "events";
import { currencyConversionTool, servicePricingLookupTool } from "../tools.js";
import { resolveSettings } from "../../lib/settings.js";
import type { AIProvider } from "./types.js";
import { PROMPT } from "./constants.js";

const DEBUG_MODE = process.env.DEBUG_MODE === "true";

const DEFAULT_SYSTEM_PROMPT = PROMPT.DEFAULT_SYSTEM_PROMPT;

export interface AgentMessageReceived {
  type: "assistant.message" | "tool.execution_start" | "tool.execution_complete" | "session.idle";
  content: string;
}

let client: CopilotClient | null = null;

async function getClient(): Promise<CopilotClient> {
  if (!client) {
    client = new CopilotClient();
    await client.start();
  }
  return client;
}

export async function checkAuth(): Promise<any> {
  const copilotClient = new CopilotClient({
    autoStart: true,
    autoRestart: false,
  });

  try {
    await copilotClient.start();
    const status = await copilotClient.getAuthStatus();
    await copilotClient.stop();
    return {
      isAuthenticated: status.isAuthenticated,
      login: status.login,
      authType: status.authType,
      statusMessage: status.statusMessage,
    };
  } catch {
    try {
      await copilotClient.forceStop();
    } catch {
      // Ignore cleanup errors
    }
    return { isAuthenticated: false };
  }
}

/**
 * GitHub Copilot implementation of the AIProvider interface
 */
export class CopilotProvider extends EventEmitter implements AIProvider {
  readonly id = "github-copilot";
  readonly name = "GitHub Copilot";
  
  private copilotClient: CopilotClient | null = null;
  private session: CopilotSession | null = null;
  private accumulatedContent: string = "";

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
    if (!this.copilotClient) {
      this.copilotClient = await getClient();
    }

    const authStatus = await this.copilotClient.getAuthStatus();
    if (!authStatus.isAuthenticated) {
      throw new Error(
        "Not authenticated with GitHub Copilot.\n\n" +
        "  Run 'copilot auth' in your terminal to log in."
      );
    }
  }

  async startSession(
    brief: string,
    options?: { skipInitialMessage?: boolean }
  ): Promise<void> {
    try {
      if (!this.copilotClient) await this.initialize();
      
      const { systemPrompt } = await resolveSettings();
      const promptToUse = systemPrompt?.trim() ? systemPrompt : DEFAULT_SYSTEM_PROMPT;
  
      this.session = await this.copilotClient!.createSession({
        sessionId: `quote-session-${Date.now()}`,
        model: "gpt-4o-mini",
        streaming: true,
        tools: [currencyConversionTool, servicePricingLookupTool],
        systemMessage: {
          mode: "append",
          content: promptToUse
        }
      });
  
      // Subscribe to session events and re-emit them
      this.session.on((data) => {
        try {
          if (DEBUG_MODE) {
            console.log(`[copilot] session event: ${data.type}`);
          }

          switch (data.type) {
            case "assistant.message":
              // Skip complete messages when streaming is enabled to avoid duplication
              if (DEBUG_MODE) {
                console.log(`[copilot] skipping assistant.message event (using streaming deltas instead)`);
              }
              break;

            case "assistant.message_delta":
              // Accumulate streaming content updates
              if ("deltaContent" in data.data && data.data.deltaContent) {
                this.accumulatedContent += data.data.deltaContent;
                if (DEBUG_MODE) {
                  console.log(`[copilot] accumulated content length: ${this.accumulatedContent.length}`);
                }
              }
              break;

            case "tool.execution_start":
              if (DEBUG_MODE) {
                console.log(`[copilot] tool execution started: ${data.data?.toolName || 'unknown'}`);
              }              
              break;

            case "tool.execution_complete":
              if (DEBUG_MODE) {
                console.log(`[copilot] tool execution completed successfully: ${data.data?.success}`);
              }
              break;

            case "session.idle":
              if (DEBUG_MODE) {
                console.log(`[copilot] session is now idle`);
              }
              
              // Emit the complete accumulated content when session is idle
              if (this.accumulatedContent.trim()) {
                if (DEBUG_MODE) {
                  console.log(`[copilot] emitting accumulated content (${this.accumulatedContent.length} chars)`);
                }
                this.emit("message", { 
                  type: "assistant.message", 
                  content: this.accumulatedContent 
                } as AgentMessageReceived);
                
                // Reset accumulated content for next interaction
                this.accumulatedContent = "";
              }
              break;

            case "session.error":
              if (DEBUG_MODE) {
                console.error(`[copilot] session error:`, data.data?.message || 'unknown error');
              }
              this.emit("error", new Error(data.data?.message || "Session error occurred"));
              break;

            default:
              if (DEBUG_MODE) {
                console.log(`[copilot] unhandled session event type: ${data.type}`);
              }
              break;
          }
        } catch (err) {
          if (DEBUG_MODE) {
            console.error("[copilot] error handling session event:", err);
          }
          this.emit("error", err as Error);
        }
      });
  
      // Optionally send the initial brief into the session
      if (!options?.skipInitialMessage) {
        await this.sendMessage(`Here is the brief for the quote:\n\n${brief}`);
      }
    } catch (error) {
      console.log("\n❌ Failed to start Copilot session. Please check your authentication and try again.\n");
      throw error;
    }
  }

  async sendMessage(message: string): Promise<void> {
    // Reset accumulated content for new interaction
    this.accumulatedContent = "";
    await this.session?.send({ prompt: message });
  }

  async endSession(): Promise<void> {
    if (this.session) {
      await this.session.destroy();
      this.emit("ended");
    }
  }
}

export async function listSessions() {
  const copilotClient = await getClient();
  const sessions = await copilotClient.listSessions();
  return sessions;
}