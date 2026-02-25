import { promises as fs } from "fs";
import os from "os";
import path from "path";

export interface SettingsStore {
  notionApiKey?: string | undefined;
  openaiApiKey?: string | undefined;
  anthropicApiKey?: string | undefined;
  selectedProvider?: string | undefined;
  notionPageId?: string | undefined;
  exchangeRateApiKey?: string | undefined;
  systemPrompt?: string | undefined;
}

const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), ".quote-cli", "settings.json");

function getSettingsPath(): string {
  return DEFAULT_SETTINGS_PATH;
}

async function ensureSettingsDir(settingsPath: string): Promise<void> {
  const dir = path.dirname(settingsPath);
  await fs.mkdir(dir, { recursive: true });
}

export async function loadSettings(): Promise<SettingsStore> {
  const settingsPath = getSettingsPath();
  try {
    const raw = await fs.readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as SettingsStore;
    if (!parsed) {
      throw new Error("Invalid settings format.");
    }
    return parsed;
  } catch (error: any) {
    if (error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function saveSettings(settings: SettingsStore): Promise<void> {
  const settingsPath = getSettingsPath();
  await ensureSettingsDir(settingsPath);
  const payload = JSON.stringify(settings, null, 2);
  await fs.writeFile(settingsPath, payload, "utf-8");
}

export async function updateSettings(
  partial: Partial<SettingsStore> & {
    notionApiKey?: string | null;
    notionPageId?: string | null;
    exchangeRateApiKey?: string | null;
    systemPrompt?: string | null;
    openaiApiKey?: string | undefined;
    anthropicApiKey?: string | undefined;
    selectedProvider?: string | undefined;
  }
): Promise<SettingsStore> {
  const existing = await loadSettings();
  const nextNotionApiKey =
    partial.notionApiKey === null ? undefined : partial.notionApiKey ?? existing.notionApiKey;
  const nextNotionPageId =
    partial.notionPageId === null ? undefined : partial.notionPageId ?? existing.notionPageId;
  const nextExchangeRateApiKey =
    partial.exchangeRateApiKey === null
      ? undefined
      : partial.exchangeRateApiKey ?? existing.exchangeRateApiKey;
  const nextSystemPrompt =
    partial.systemPrompt === null ? undefined : partial.systemPrompt ?? existing.systemPrompt;
  const nextOpenAIApiKey =
    partial.openaiApiKey === null ? undefined : partial.openaiApiKey ?? existing.openaiApiKey;
  const nextAnthropicApiKey =
    partial.anthropicApiKey === null ? undefined : partial.anthropicApiKey ?? existing.anthropicApiKey;
  const nextSelectedProvider =
    partial.selectedProvider === null ? undefined : partial.selectedProvider ?? existing.selectedProvider;

  const merged: SettingsStore = {
    ...(nextNotionApiKey !== undefined ? { notionApiKey: nextNotionApiKey } : {}),
    ...(nextNotionPageId !== undefined ? { notionPageId: nextNotionPageId } : {}),
    ...(nextExchangeRateApiKey !== undefined ? { exchangeRateApiKey: nextExchangeRateApiKey } : {}),
    ...(nextSystemPrompt !== undefined ? { systemPrompt: nextSystemPrompt } : {}),
    ...(nextOpenAIApiKey !== undefined ? { openaiApiKey: nextOpenAIApiKey } : {}),
    ...(nextAnthropicApiKey !== undefined ? { anthropicApiKey: nextAnthropicApiKey } : {}),
    ...(nextSelectedProvider !== undefined ? { selectedProvider: nextSelectedProvider } : {}),
  };
  await saveSettings(merged);
  return merged;
}

export async function resolveSettings(): Promise<{
  notionApiKey?: string;
  notionPageId?: string;
  exchangeRateApiKey?: string;
  systemPrompt?: string;
  openaiApiKey?: string | undefined;
  anthropicApiKey?: string | undefined;
  selectedProvider?: string | undefined;
}> {
  const settings = await loadSettings();
  return {
    notionApiKey: settings.notionApiKey ?? (process.env.NOTION_API_KEY as string),
    notionPageId: settings.notionPageId ?? (process.env.NOTION_PAGE_ID as string),
    exchangeRateApiKey: settings.exchangeRateApiKey ?? (process.env.EXCHANGE_RATE_API_KEY as string),
    systemPrompt: settings.systemPrompt ?? "",
    openaiApiKey: settings.openaiApiKey ?? (process.env.OPENAI_API_KEY as string),
    anthropicApiKey: settings.anthropicApiKey ?? (process.env.ANTHROPIC_API_KEY as string),
    selectedProvider: settings.selectedProvider ?? "github-copilot",
  };
}
