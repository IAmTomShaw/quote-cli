import * as readline from "readline";
import { displayHeader } from "./ui/header.js";
import { CopilotProvider } from "./agent/providers/copilot.provider.js";
import { OpenAIProvider } from "./agent/providers/openai.provider.js";
import { AnthropicProvider } from "./agent/providers/anthropic.provider.js";
import type { AIProvider } from "./agent/providers/types.js";
import { displayMenu } from "./ui/menu.js";
import {
  appendQuoteSession,
  generateSessionId,
  listQuoteSessions,
  updateQuoteSession,
  type StoredMessage,
  type StoredQuote,
} from "./lib/storage.js";
import { loadSettings, updateSettings, resolveSettings } from "./lib/settings.js";
import { createSpinner } from "./ui/spinner.js";
import { exit } from "process";

const DEBUG_MODE = process.env.DEBUG_MODE === "true";
const MAX_HISTORY_MESSAGES = 20;

// Helper: Factory function to instantiate the correct provider based on settings
async function getAgent(): Promise<AIProvider> {
  const settings = await resolveSettings();
  switch (settings.selectedProvider) {
    case "openai": return new OpenAIProvider();
    case "anthropic": return new AnthropicProvider(); // <-- DODANE
    default: return new CopilotProvider();
  }
}

// Helper: collect multiple agent 'message' events until session goes idle
const collectAgentMessages = (
  agent: AIProvider,
  onMessage: (m: any, first: boolean) => void,
  maxWaitMs = 30000 // Maximum wait time
): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    if (DEBUG_MODE) {
      console.log(`[collector] starting collectAgentMessages (maxWaitMs=${maxWaitMs})`);
    }

    let first = true;
    let hasContent = false;
    let maxWaitTimer: NodeJS.Timeout | null = null;
    let accumulatedContent = "";

    let cleanup = () => {
      // We rely on the unified onMessage method from AIProvider interface
      if (maxWaitTimer) clearTimeout(maxWaitTimer);
    };

    const messageHandler = (content: string) => {
      if (DEBUG_MODE) {
        console.log("[collector] received agent message event");
      }

      // Handle streaming content (accumulate deltas)
      if (content) {
        // If this looks like a delta (short content), accumulate it
        if (content.length < 50 && !content.includes("\n")) {
          accumulatedContent += content;
          return; // Don't emit individual deltas
        } else {
          // This is a complete message or we have accumulated content
          if (accumulatedContent) {
            content = accumulatedContent + content;
            accumulatedContent = "";
          }

          onMessage({ content }, first);
          first = false;
          hasContent = true;
        }
      }
    };

    // Listen for session idle event through the agent's session emitter if available
    const originalSession = (agent as any).session;
    if (originalSession && originalSession.on) {
      const sessionIdleHandler = (event: any) => {
        if (event.type === "session.idle" || event === "session.idle") {
          if (DEBUG_MODE) {
            console.log("[collector] session idle detected, finishing collection");
          }

          // If we have accumulated content, emit it
          if (accumulatedContent) {
            onMessage({ content: accumulatedContent }, first);
          }

          cleanup();
          resolve();
        }
      };

      originalSession.on("session.idle", sessionIdleHandler);

      const originalCleanup = cleanup;
      cleanup = () => {
        originalCleanup();
        try {
          originalSession.removeListener("session.idle", sessionIdleHandler);
        } catch (e) {
          /* ignore */
        }
      };
    }

    // Safety timeout
    maxWaitTimer = setTimeout(() => {
      if (DEBUG_MODE) {
        console.warn(`[collector] max wait timeout (${maxWaitMs}ms) reached`);
      }

      // If we have accumulated content, emit it
      if (accumulatedContent) {
        onMessage({ content: accumulatedContent }, first);
      }

      cleanup();
      if (hasContent) {
        resolve(); // We got some content, so it's a success
      } else {
        reject(new Error("No response received within timeout"));
      }
    }, maxWaitMs);

    // Register our callback using the AIProvider interface method
    agent.onMessage(messageHandler);
  });
};

// handler functions

function maskValue(value?: string): string {
  if (!value) return "not set";
  if (value.length <= 8) {
    return `${value.slice(0, 1)}***${value.slice(-1)}`;
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function parseSettingsInput(input: string): string | null | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === "clear") return null;
  return trimmed;
}

async function promptQuestion(mainRl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    mainRl.question(question, (answer) => resolve(answer));
  });
}

async function collectMultilineInput(
  mainRl: readline.Interface,
  sentinel = "."
): Promise<string> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const handler = (line: string) => {
      if (line.trim() === sentinel) {
        mainRl.removeListener("line", handler);
        resolve(lines.join("\n"));
        return;
      }
      lines.push(line);
    };
    mainRl.on("line", handler);
    mainRl.setPrompt("> ");
    mainRl.prompt();
  });
}

async function settingsFlow(mainRl: readline.Interface): Promise<void> {
  const mainLineListeners = mainRl.listeners("line").slice();
  mainLineListeners.forEach((l) => mainRl.removeListener("line", l as any));

  try {
    const settings = await resolveSettings();
    console.log("\n🔧 Settings\n");
    console.log(`Current SELECTED_PROVIDER: ${settings.selectedProvider || "not set"}`);
    console.log(`Current NOTION_API_KEY: ${maskValue(settings.notionApiKey)}`);
    console.log(`Current NOTION_PAGE_ID: ${maskValue(settings.notionPageId)}`);
    console.log(`Current EXCHANGE_RATE_API_KEY: ${maskValue(settings.exchangeRateApiKey)}`);
    console.log(`Current OPENAI_API_KEY: ${maskValue(settings.openaiApiKey)}`);
    console.log("\nEnter a value to update, press Enter to keep, or type 'clear' to remove.\n");

    mainRl.resume();
    const providerInput = await promptQuestion(mainRl, "SELECTED_PROVIDER (copilot/openai/anthropic): ");
    const notionApiKeyInput = await promptQuestion(mainRl, "NOTION_API_KEY: ");
    const notionPageIdInput = await promptQuestion(mainRl, "NOTION_PAGE_ID: ");
    const exchangeRateApiKeyInput = await promptQuestion(mainRl, "EXCHANGE_RATE_API_KEY: ");
    const openaiApiKeyInput = await promptQuestion(mainRl, "OPENAI_API_KEY: ");
    const anthropicApiKeyInput = await promptQuestion(mainRl, "ANTHROPIC_API_KEY: ");

    const selectedProvider = parseSettingsInput(providerInput);
    const notionApiKey = parseSettingsInput(notionApiKeyInput);
    const notionPageId = parseSettingsInput(notionPageIdInput);
    const exchangeRateApiKey = parseSettingsInput(exchangeRateApiKeyInput);
    const openaiApiKey = parseSettingsInput(openaiApiKeyInput);
    const anthropicApiKey = parseSettingsInput(anthropicApiKeyInput);

    let newSettings: any = {};

    if (selectedProvider !== undefined) newSettings.selectedProvider = selectedProvider;
    if (notionApiKey !== undefined) newSettings.notionApiKey = notionApiKey;
    if (notionPageId !== undefined) newSettings.notionPageId = notionPageId;
    if (exchangeRateApiKey !== undefined) newSettings.exchangeRateApiKey = exchangeRateApiKey;
    if (openaiApiKey !== undefined) newSettings.openaiApiKey = openaiApiKey;
    if (anthropicApiKey !== undefined) newSettings.anthropicApiKey = anthropicApiKey;

    await updateSettings(newSettings);

    const status = (input: string | null | undefined) =>
      input === undefined ? "unchanged" : input === null ? "cleared" : "updated";

    console.log("\n✅ Settings saved.");
    console.log(`SELECTED_PROVIDER: ${status(selectedProvider)}`);
    console.log(`NOTION_API_KEY: ${status(notionApiKey)}`);
    console.log(`NOTION_PAGE_ID: ${status(notionPageId)}`);
    console.log(`EXCHANGE_RATE_API_KEY: ${status(exchangeRateApiKey)}`);
    console.log(`OPENAI_API_KEY: ${status(openaiApiKey)}`);
    console.log(`ANTHROPIC_API_KEY: ${status(anthropicApiKey)}`);
  } catch (error) {
    console.log("\n❌ Failed to update settings.\n");
    if (DEBUG_MODE) console.error(error);
  } finally {
    mainLineListeners.forEach((l) => mainRl.on("line", l as any));
    mainRl.setPrompt("\x1b[1m\x1b[94m👀 Select function:\x1b[0m ");
    mainRl.prompt();
  }
}

async function promptFlow(mainRl: readline.Interface): Promise<void> {
  const mainLineListeners = mainRl.listeners("line").slice();
  mainLineListeners.forEach((l) => mainRl.removeListener("line", l as any));

  try {
    const settings = await loadSettings();
    const currentPrompt = settings.systemPrompt;

    console.log("\n📝 System Prompt\n");
    if (currentPrompt && currentPrompt.trim()) {
      console.log("Current system prompt (preview):");
      const preview = currentPrompt.length > 300 ? `${currentPrompt.slice(0, 300)}...` : currentPrompt;
      console.log(`${preview}\n`);
    } else {
      console.log("No custom system prompt is set.\n");
    }

    console.log("Paste the new system prompt below.");
    console.log("Finish by entering a single line with a dot (.)");
    console.log("Type 'clear' to remove the custom prompt.\n");

    mainRl.resume();
    const firstLine = await promptQuestion(mainRl, "> ");
    const trimmed = firstLine.trim();

    if (trimmed.toLowerCase() === "clear") {
      await updateSettings({ systemPrompt: "" });
      console.log("\n✅ System prompt cleared.\n");
    } else {
      let promptText = firstLine;
      if (trimmed !== ".") {
        const rest = await collectMultilineInput(mainRl);
        promptText = [firstLine, rest].filter(Boolean).join("\n");
      } else {
        promptText = "";
      }

      if (!promptText.trim()) {
        console.log("\n⚠️ Empty prompt detected. No changes made.\n");
      } else {
        await updateSettings({ systemPrompt: promptText });
        console.log("\n✅ System prompt updated.\n");
      }
    }
  } catch (error) {
    console.log("\n❌ Failed to update system prompt.\n");
    if (DEBUG_MODE) console.error(error);
  } finally {
    mainLineListeners.forEach((l) => mainRl.on("line", l as any));
    mainRl.setPrompt("\x1b[1m\x1b[94m👀 Select function:\x1b[0m ");
    mainRl.prompt();
  }
}

async function handleCommand(input: string, mainRl: readline.Interface) {
  if (input.startsWith("/create ")) {
    const brief = input.substring(8).trim();
    createQuoteFlow(brief, mainRl).then(() => false).then(() => {
      mainRl.setPrompt("\x1b[1m\x1b[94m👀 Select function:\x1b[0m ");
      mainRl.prompt();
    });
    return false;
  } else {
    console.log("\n❌ Unknown command. Type /help to see available commands.\n");
    mainRl.prompt();
    return false;
  }
}

async function createQuoteFlow(brief: string, mainRl: readline.Interface): Promise<void> {
  // Store listeners to restore them later
  const mainLineListeners = mainRl.listeners("line").slice();

  try {
    if (!brief || brief.trim() === "") {
      console.log("❌ Please provide a brief for your quote. Usage: /create <brief>\n");
      return;
    }

    console.log("\n🤖 Starting Quote Assistant...\n");
    console.log("━".repeat(50));
    console.log("💼 Quote Brief:", brief.trim());
    console.log("━".repeat(50));
    console.log("\nType your messages to discuss the quote.");
    console.log("Commands: /close - exit the chat session\n");

    // Remove main listeners to avoid duplicate handling
    mainLineListeners.forEach((l) => mainRl.removeListener("line", l as any));
    mainRl.pause();

    // 1. Initialize agent
    const agent = await getAgent();
    const sessionId = generateSessionId();
    const sessionCreatedAt = new Date().toISOString();
    const storedMessages: StoredMessage[] = [];
    let finalSummary: string | undefined;

    // --- CRITICAL PART: Session Start ---
    try {
      await agent.startSession(brief.trim());
    } catch (startError: any) {
      // Catch specific initialization errors (like missing API keys)
      // and throw them with a clean message to be handled by the outer catch
      throw new Error(startError.message || "Failed to start agent session");
    }
    // ------------------------------------

    const recordUserMessage = (content: string) => {
      storedMessages.push({
        role: "user",
        content,
        timestamp: new Date().toISOString(),
      });
    };

    const recordAssistantMessage = (content: string) => {
      storedMessages.push({
        role: "assistant",
        content,
        timestamp: new Date().toISOString(),
      });
    };

    // Show inline loading indicator
    process.stdout.write("\x1b[1m\x1b[35m🤖 Agent is responding...\x1b[0m");
    await collectAgentMessages(agent, (msg: any, first: boolean) => {
      if (first) process.stdout.write("\r\x1b[2K");
      console.log(`\n\x1b[1m\x1b[35m🤖 Agent:\x1b[0m ${msg.content}\n`);
      if (msg.content) {
        recordAssistantMessage(msg.content);
      }
    });

    mainRl.setPrompt("\x1b[1m\x1b[94m💻 You:\x1b[0m ");
    mainRl.resume();
    mainRl.prompt();

    // ... (Chat loop / Promise that handles /close logic) ...
    // Note: Make sure the chat loop is also inside this main try block

  } catch (error: any) {
    // 2. Clean Error Display
    // This will show only the message without the full stack trace
    console.log(`\n\x1b[1;31m❌ Error:\x1b[0m ${error.message || "An unexpected error occurred."}\n`);
    
    if (DEBUG_MODE) {
      console.error(error); // Full stack trace only in debug mode
    }
  } finally {
    // 3. Guaranteed Recovery
    // This ensures that no matter what happened, the CLI returns to normal state
    mainLineListeners.forEach((l) => mainRl.on("line", l as any));
    mainRl.setPrompt("\x1b[1m\x1b[94m👀 Select function:\x1b[0m ");
    mainRl.prompt();
    mainRl.resume();
  }
}

function formatHistoryForAgent(messages: StoredMessage[], maxMessages: number): string {
  const slice = messages.slice(-maxMessages);
  return slice
    .map((message) => {
      const label = message.role === "user" ? "User" : "Assistant";
      return `${label}: ${message.content}`;
    })
    .join("\n");
}

function printTranscriptPreview(messages: StoredMessage[], maxMessages: number): void {
  if (!messages.length) {
    console.log("\n(No previous messages)\n");
    return;
  }
  const total = messages.length;
  const slice = messages.slice(-maxMessages);
  if (total > maxMessages) {
    console.log(`\nShowing last ${maxMessages} of ${total} messages:\n`);
  } else {
    console.log("\nPrevious messages:\n");
  }
  slice.forEach((message) => {
    const label = message.role === "user" ? "You" : "Agent";
    console.log(`${label}: ${message.content}`);
  });
  console.log("");
}

async function openQuoteFlow(session: StoredQuote, mainRl: readline.Interface): Promise<void> {
  try {
    console.log("\n🔓 Opening saved quote session...\n");
    console.log("━".repeat(50));
    console.log("💼 Quote Brief:", session.brief);
    console.log("━".repeat(50));
    printTranscriptPreview(session.messages, MAX_HISTORY_MESSAGES);
    console.log("Type your messages to continue this quote conversation.");
    console.log("Commands: /close - exit the chat session\n");

    const mainLineListeners = mainRl.listeners("line").slice();
    mainLineListeners.forEach((l) => mainRl.removeListener("line", l as any));
    mainRl.pause();

    const agent = await getAgent();
    const storedMessages: StoredMessage[] = [...session.messages];
    let finalSummary: string | undefined = session.finalSummary;

    const recordUserMessage = (content: string) => {
      storedMessages.push({
        role: "user",
        content,
        timestamp: new Date().toISOString(),
      });
    };

    const recordAssistantMessage = (content: string) => {
      storedMessages.push({
        role: "assistant",
        content,
        timestamp: new Date().toISOString(),
      });
    };

    const historyContext = formatHistoryForAgent(storedMessages, MAX_HISTORY_MESSAGES);
    let firstUserMessage = true;

    await agent.startSession(session.brief, { skipInitialMessage: true });

    mainRl.setPrompt("\x1b[1m\x1b[94m💻 You:\x1b[0m ");
    mainRl.resume();
    mainRl.prompt();

    await new Promise<void>((resolve) => {
      const quoteHandler = async (line: string) => {
        const input = line.trim();

        if (input === "/close") {
          console.log("\n✅ Quote session complete! Saving...\n");
          process.stdout.write("\x1b[1m\x1b[35m🤖 Agent is responding...\x1b[0m");
          await agent.sendMessage(
            "Please provide a final summary of the quote we discussed, formatted nicely."
          );
          await collectAgentMessages(agent, (msg: any, first: boolean) => {
            if (first) process.stdout.write("\r\x1b[2K");
            if (msg.content !== "") {
              console.log(`\n\x1b[1m\x1b[35m🤖 Agent:\x1b[0m\n\n📋 Final Quote Summary:\n${msg.content}\n`);
              recordAssistantMessage(msg.content);
              finalSummary = msg.content;
            }
          });
          await agent.endSession();
          try {
            const sessionRecord: StoredQuote = {
              id: session.id,
              brief: session.brief,
              createdAt: session.createdAt,
              messages: storedMessages,
              ...(finalSummary ? { finalSummary } : {}),
            };
            await updateQuoteSession(sessionRecord);
            console.log("💾 Session updated in history.\n");
          } catch (error) {
            console.log("\n⚠️ Failed to update session history.\n");
            if (DEBUG_MODE) console.error(error);
          }
          mainRl.removeListener("line", quoteHandler);
          resolve();
          return;
        }

        if (input === "") {
          mainRl.prompt();
          return;
        }

        mainRl.pause();
        try {
          process.stdout.write("\x1b[1m\x1b[35m🤖 Agent is responding...\x1b[0m");
          recordUserMessage(input);
          if (firstUserMessage) {
            const contextualPrompt = historyContext
              ? `Here is the brief for the quote:\n\n${session.brief}\n\nPrevious conversation (most recent messages):\n${historyContext}\n\nUser: ${input}`
              : `Here is the brief for the quote:\n\n${session.brief}\n\nUser: ${input}`;
            await agent.sendMessage(contextualPrompt);
            firstUserMessage = false;
          } else {
            await agent.sendMessage(input);
          }
          await collectAgentMessages(agent, (msg: any, first: boolean) => {
            if (first) process.stdout.write("\r\x1b[2K");
            if (msg.content !== "") {
              console.log(`\n\x1b[1m\x1b[35m🤖 Agent:\x1b[0m ${msg.content}\n`);
              recordAssistantMessage(msg.content);
            }
          });
        } catch (error) {
          console.log("\n❌ Error communicating with agent. Please try again.\n");
        } finally {
          mainRl.resume();
        }

        mainRl.prompt();
      };

      mainRl.on("line", quoteHandler);
    });

    mainLineListeners.forEach((l) => mainRl.on("line", l as any));
    mainRl.setPrompt("\x1b[1m\x1b[94m👀 Select function:\x1b[0m ");
    mainRl.prompt();
  } catch (error) {
    console.log("\n❌ Failed to open quote session.\n");
    if (DEBUG_MODE) console.error(error);
  }
}

async function listQuotesFlow(mainRl: readline.Interface): Promise<void> {
  try {
    const sessions = await listQuoteSessions();
    if (!sessions.length) {
      console.log("\nℹ️ No saved quote sessions yet.\n");
      return;
    }

    const renderPlainList = () => {
      console.log("\n📚 Saved Quote Sessions:\n");
      sessions.forEach((session, index) => {
        const createdAt = new Date(session.createdAt).toLocaleString();
        const brief = session.brief.length > 60
          ? `${session.brief.slice(0, 57)}...`
          : session.brief;
        const messageCount = session.messages.length;
        console.log(`${index + 1}. ${createdAt} - ${brief} (${messageCount} messages)`);
      });
      console.log("");
    };

    const mainLineListeners = mainRl.listeners("line").slice();
    mainLineListeners.forEach((l) => mainRl.removeListener("line", l as any));

    const wasRaw = process.stdin.isRaw;
    mainRl.pause();
    readline.emitKeypressEvents(process.stdin);

    if (!process.stdin.isTTY || !process.stdin.setRawMode) {
      renderPlainList();
      mainLineListeners.forEach((l) => mainRl.on("line", l as any));
      mainRl.resume();
      return;
    }

    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    } catch {
      renderPlainList();
      mainLineListeners.forEach((l) => mainRl.on("line", l as any));
      mainRl.resume();
      return;
    }

    let selected = 0;

    const render = () => {
      process.stdout.write("\x1b[2J\x1b[0f");
      console.log("📚 Use Up/Down to navigate — Enter: open, q: cancel\n");
      for (let i = 0; i < sessions.length; i++) {
        const session = sessions[i];
        if (!session) continue;
        const createdAt = new Date(session.createdAt).toLocaleString();
        const brief = session.brief.length > 60
          ? `${session.brief.slice(0, 57)}...`
          : session.brief;
        const messageCount = session.messages.length;
        const isSelected = i === selected;
        const prefix = isSelected ? "\x1b[1m\x1b[92m→\x1b[0m " : "  ";
        const line = `${createdAt} - ${brief} (${messageCount} messages)`;
        if (isSelected) {
          console.log(`${prefix}\x1b[1m\x1b[36m${line}\x1b[0m`);
        } else {
          console.log(`${prefix}${line}`);
        }
      }
    };

    await new Promise<void>((resolve) => {
      const onKey = async (str: string, key: readline.Key) => {
        if (key.name === "up") {
          selected = (selected - 1 + sessions.length) % sessions.length;
          render();
        } else if (key.name === "down") {
          selected = (selected + 1) % sessions.length;
          render();
        } else if (key.name === "return" || key.name === "enter") {
          const session = sessions[selected];
          if (!session) return;
          cleanup();
          await openQuoteFlow(session, mainRl);
          resolve();
        } else if (str === "q" || (key.ctrl && key.name === "c") || key.name === "escape") {
          cleanup();
          console.log("\nCancelled.\n");
          resolve();
        }
      };

      const cleanup = () => {
        process.stdin.removeListener("keypress", onKey);
        try {
          process.stdin.setRawMode(!!wasRaw);
        } catch {
          // ignore
        }
        mainLineListeners.forEach((l) => mainRl.on("line", l as any));
        mainRl.resume();
      };

      process.stdin.on("keypress", onKey);
      render();
    });
  } catch (error) {
    console.log("\n❌ Failed to load saved quotes.\n");
    if (DEBUG_MODE) console.error(error);
  }
}

// Run the main CLI application

async function runCli() {
  try {
    displayHeader();

    // Get current settings to see who is the provider
    const settings = await resolveSettings();
    const agent = await getAgent();
    const agentName = agent.name;

    // Initialize with a non-blocking approach
    const spinner = createSpinner(`Initializing ${agentName} provider...`);
    spinner.start();

    try {
      await agent.initialize();
      spinner.stop(`\n\x1b[1;94m✅ Connected to ${agentName}! Ready to work.\x1b[0m\n`);
    } catch (err: any) {
      // INSTEAD OF exit(1), we just show a warning
      spinner.stop(`\n\x1b[1;33m⚠️  Warning: ${agentName} is not ready.\x1b[0m`);
      console.log(`\x1b[90m(${err.message})\x1b[0m`);
      console.log(`\x1b[36mPlease use /settings to configure your API keys.\x1b[0m\n`);
    }

    displayMenu();

    const mainRl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // Store original main listeners to restore later
    const mainLineListeners = mainRl.listeners("line").slice();

    mainRl.setPrompt("\x1b[1m\x1b[94m👀 Select function:\x1b[0m ");
    mainRl.prompt();
    
    // Main command loop
    mainRl.on("line", async (input: string) => {
      const trimmedInput = input.trim();
      switch (trimmedInput) {
        case "/help":
          displayMenu();
          mainRl.prompt()
          break;
        case "/exit":
        case "/quit":
          console.log("\n👋 Exiting Quote CLI. Goodbye!\n")
          process.exit(0)
        case "/list":
          await listQuotesFlow(mainRl);
          mainRl.prompt()
          break;
        case "/settings":
          await settingsFlow(mainRl);
          break;
        case "/prompt":
          await promptFlow(mainRl);
          break;
        case "/create":
          console.log("\n❌ Usage: /create <brief>\n");
          console.log("Example: /create Website redesign for small business\n");
          mainRl.prompt()
          break;
        default:
          await handleCommand(trimmedInput, mainRl)
      }
    });

  }
  catch (error) {
    console.log("\n❌ An unexpected error occurred. Please try again.\n");
    console.error(error);
  }
}

runCli();