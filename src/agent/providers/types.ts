/**
 * Standard interface for all AI service providers (Copilot, OpenAI, etc.)
 */
export interface AIProvider {
  /** unique identifier for the provider */
  readonly id: string;
  
  /** name displayed in the CLI menu */
  readonly name: string;

  /**
   * Initializes the provider with necessary credentials/settings
   */
  initialize(): Promise<void>;

  /**
   * Starts a new chat session with the provided brief.
   * * @param brief The initial context or requirements for the quote.
   * @param options Configuration options for the session start.
   */
  startSession(brief: string, options?: { skipInitialMessage?: boolean }): Promise<void>;

  /**
   * Sends a message to the AI and handles the response
   * @param message User input string
   */
  sendMessage(message: string): Promise<void>;

  /**
   * Cleans up resources or ends the current session
   */
  endSession(): Promise<void>;

  /**
   * Event emitter for streaming or final messages
   * @param callback Function to call with each new message content
   */
  onMessage(callback: (content: string) => void): void;
}

/*
  * Standardized message format for incoming messages from providers
  * This can be extended in the future to include metadata, message types, etc.
  * For now, it's a simple structure to allow the OpenAI provider to emit messages in a consistent way.
*/
export interface AgentMessageReceived{
  type: string;
  content: string;
}