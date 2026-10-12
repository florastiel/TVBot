// Every Claude API call goes through claudeClient(): same SDK client, but each call's token counts
// are appended to ONE shared log (one JSON line: when, project, purpose, model, input, output) that
// the money dashboard reads for its weekly "how much did Claude cost" notification. Only counts are
// stored - never prompts, answers or keys. Location: CLAUDE_USAGE_LOG, else claude.usage_log in
// config.yaml, else data\claude-usage.jsonl. Also here: the monthly ceiling for the automatic
// filing and splitting (brand_sort.monthly_ceiling_usd), which switches Claude off for those two
// until next month rather than spend past it.
import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config, secrets, DATA_DIR } from "./config.js";
import { log } from "./log.js";

export const usageLogPath = () => process.env.CLAUDE_USAGE_LOG || config.claude.usage_log || join(DATA_DIR, "claude-usage.jsonl");

// Dollars per million tokens (input, output) - the same table as the money dashboard's
// src/lib/claudeUsage.ts. Edit both when Anthropic's prices change.
const PRICES = {
  "claude-fable-5-1": [10, 50], "claude-fable-5": [10, 50],
  "claude-opus-5-5": [4, 20], "claude-opus-5": [5, 25], "claude-opus-4-8": [5, 25],
  "claude-sonnet-5-5": [2, 10], "claude-sonnet-5": [2, 10], "claude-sonnet-4-6": [3, 15],
  "claude-haiku-5-5": [0.1, 0.5], "claude-haiku-4-5": [1, 5],
};
export function costOf(model, input, output, batch = false) {
  const key = Object.keys(PRICES).filter((k) => String(model).startsWith(k)).sort((a, b) => b.length - a.length)[0];
  const [pi, po] = key ? PRICES[key] : [10, 50]; // an unknown model is priced high
  return ((input * pi + output * po) / 1e6) * (batch ? 0.5 : 1);
}

export function logUsage({ purpose, model, input, output, batch = false }) {
  try {
    const file = usageLogPath();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), project: "tvchannel", purpose, model, input: input || 0, output: output || 0, ...(batch ? { batch: true } : {}) }) + "\n");
  } catch { /* never let logging break a call */ }
}

export function claudeClient(purpose) {
  const client = new Anthropic({ apiKey: secrets.anthropicKey });
  const create = client.messages.create.bind(client.messages);
  client.messages.create = async (...args) => {
    const msg = await create(...args);
    if (msg?.usage) logUsage({ purpose, model: msg.model || args[0]?.model, input: msg.usage.input_tokens, output: msg.usage.output_tokens });
    return msg;
  };
  return client;
}

// This calendar month's cost of the automatic filing and splitting (not the weekly tagging/planning).
const AUTO = new Set(["brandsort", "eyesplit"]);
export function autoSpendThisMonth() {
  const d = new Date(), from = new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
  let usd = 0, raw = "";
  try { raw = readFileSync(usageLogPath(), "utf8"); } catch { return 0; }
  for (const line of raw.split("\n")) {
    if (!line.includes('"tvchannel"')) continue;
    try {
      const j = JSON.parse(line);
      if (j.project === "tvchannel" && AUTO.has(j.purpose) && j.at >= from) usd += costOf(j.model, Number(j.input) || 0, Number(j.output) || 0, !!j.batch);
    } catch { /* torn line */ }
  }
  return usd;
}

let warnedMonth = "";
// true while this month's automatic Claude spend is under brand_sort.monthly_ceiling_usd (0 = no ceiling).
export function underCeiling() {
  const cap = Number(config.brand_sort?.monthly_ceiling_usd);
  if (!(cap > 0)) return true;
  const spent = autoSpendThisMonth();
  if (spent < cap) return true;
  const month = new Date().toISOString().slice(0, 7);
  if (warnedMonth !== month) {
    warnedMonth = month;
    log.warn(`claude: this month's automatic filing/splitting has used about $${spent.toFixed(2)} of its $${cap.toFixed(2)} ceiling; Claude is off for those until next month (brand_sort.monthly_ceiling_usd)`);
  }
  return false;
}