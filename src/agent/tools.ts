import { defineTool, type ToolResultObject } from "@github/copilot-sdk";
import axios from "axios";
import { resolveSettings } from "../lib/settings.js";

const DEBUG_MODE = process.env.DEBUG_MODE === "true";

// Extract plain text content from Notion API blocks response
function extractNotionTextContent(notionResponse: any): string {
  if (!notionResponse?.results || !Array.isArray(notionResponse.results)) {
    return "No content found in Notion response.";
  }

  const textParts: string[] = [];

  for (const block of notionResponse.results) {
    if (!block.type) continue;

    let blockText = "";
    
    // Handle different block types that contain rich_text
    const blockData = block[block.type];
    if (blockData?.rich_text && Array.isArray(blockData.rich_text)) {
      // Extract plain_text from each rich_text element
      const richTexts = blockData.rich_text
        .map((richText: any) => richText.plain_text || "")
        .filter((text: string) => text.length > 0);
      
      blockText = richTexts.join("");
    }

    // Add formatting based on block type
    if (blockText.trim()) {
      switch (block.type) {
        case "heading_1":
          textParts.push(`\n# ${blockText}\n`);
          break;
        case "heading_2":
          textParts.push(`\n## ${blockText}\n`);
          break;
        case "heading_3":
          textParts.push(`\n### ${blockText}\n`);
          break;
        case "paragraph":
          textParts.push(blockText);
          break;
        default:
          textParts.push(blockText);
          break;
      }
    } else if (block.type === "paragraph") {
      // Empty paragraphs create line breaks
      textParts.push("\n");
    }
  }

  return textParts.join("").trim();
}

export async function fetchPricingFromNotion(): Promise<string> {
  if (DEBUG_MODE) {
    console.log('[fetchPricingFromNotion] invoked');
  }

  const { notionApiKey, notionPageId } = await resolveSettings();
  
  if (!notionPageId || !notionApiKey) {
    const msg = "Notion credentials are not configured.";
    if (DEBUG_MODE) console.warn("[fetchPricingFromNotion]", msg);
    throw new Error(msg);
  }

  const apiUrl = `https://api.notion.com/v1/blocks/${notionPageId}/children`;
  const headers = {
    Authorization: `Bearer ${notionApiKey}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };

  try {
    if (DEBUG_MODE) {
      console.log(`[fetchPricingFromNotion] fetching Notion blocks for page ${notionPageId}`);
    }
    const resp = await axios.get(apiUrl, { headers });
    if (DEBUG_MODE) {
      console.log(`[fetchPricingFromNotion] response status ${resp.status}`);
    }
    return extractNotionTextContent(resp.data);
  } catch (error) {
    if (DEBUG_MODE) {
      const status = axios.isAxiosError(error) && error.response ? error.response.status : "n/a";
      const body = axios.isAxiosError(error) && error.response ? JSON.stringify(error.response.data) : String(error);
      console.error("[fetchPricingFromNotion] error fetching Notion data:", status, body);
    }
    throw error;
  }
}

export async function convertCurrency(amount: number, fromCurrency: string, toCurrency: string): Promise<string> {
  if (DEBUG_MODE) {
    console.log(`[convertCurrency] invoked with amount: ${amount}, from: ${fromCurrency}, to: ${toCurrency}`);
  }

  const { exchangeRateApiKey } = await resolveSettings();
  
  if (!exchangeRateApiKey) {
    const msg = "EXCHANGE_RATE_API_KEY is not configured.";
    if (DEBUG_MODE) console.warn("[convertCurrency]", msg);
    throw new Error(msg);
  }

  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  const apiUrl = `https://v6.exchangerate-api.com/v6/${exchangeRateApiKey}/pair/${from}/${to}`;
  
  try {
    const resp = await axios.get(apiUrl);
    const data = resp.data;

    if (!data || data.result !== "success" || typeof data.conversion_rate !== "number") {
      throw new Error(`Exchange rate API error: ${JSON.stringify(data)}`);
    }

    const convertedAmount = amount * data.conversion_rate;
    
    if (DEBUG_MODE) {
      console.log(`[convertCurrency] conversion successful: ${convertedAmount}`);
    }
    
    return `Converted amount: ${convertedAmount.toFixed(2)} ${to}`;
  } catch (error) {
    if (DEBUG_MODE) {
      console.error("[convertCurrency] error fetching exchange rate data:", error);
    }
    throw error;
  }
}

// --- COPILOT SDK TOOLS ---

export const servicePricingLookupTool = defineTool("servicePricingLookupTool", {
  description: "Retreive the service pricing list from Notion in the form of plain text.",
  parameters: { type: "object", properties: {}, required: [] },
  handler: async (): Promise<ToolResultObject> => {
    try {
      const textContent = await fetchPricingFromNotion();
      return {
        textResultForLlm: `Tom Shaw's Pricing Information:\n\n${textContent}`,
        resultType: "success",
      };
    } catch (error) {
      return { textResultForLlm: String(error), resultType: "failure" };
    }
  },
});

export const currencyConversionTool = defineTool<{amount: number; fromCurrency: string; toCurrency: string;}>("convert_currency", {
  description: "Convert an amount from one currency to another.",
  parameters: {
    type: "object",
    properties: {
      amount: { type: "number", description: "The amount of money to convert." },
      fromCurrency: { type: "string", description: "The currency code to convert from (e.g., USD)." },
      toCurrency: { type: "string", description: "The currency code to convert to (e.g., EUR)." },
    },
    required: ["amount", "fromCurrency", "toCurrency"],
  },
  handler: async (args): Promise<ToolResultObject> => {
    try {
      const result = await convertCurrency(args.amount, args.fromCurrency, args.toCurrency);
      return { textResultForLlm: result, resultType: "success" };
    } catch (error) {
      return { textResultForLlm: String(error), resultType: "failure" };
    }
  },
});

// ---  OPENAI TOOLS ---

export const openaiToolsDefinitions: import("openai").OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "servicePricingLookupTool",
      description: "Retreive the service pricing list from Notion in the form of plain text.",
    }
  },
  {
    type: "function",
    function: {
      name: "convert_currency",
      description: "Convert an amount from one currency to another.",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "The amount of money to convert." },
          fromCurrency: { type: "string", description: "The currency code to convert from (e.g., USD)." },
          toCurrency: { type: "string", description: "The currency code to convert to (e.g., EUR)." },
        },
        required: ["amount", "fromCurrency", "toCurrency"],
      }
    }
  }
];