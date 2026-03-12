#!/usr/bin/env bun
/** nanocode - minimal deep coding agent */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import * as readline from "node:readline";

// --- Config ---
const COMPACT_THRESHOLD = 150000;
const TOOL_SUMMARIZE_THRESHOLD = 200;
const SESSIONS_DIR = `${process.env.HOME}/.nanocode/sessions`;

type ProviderConfig = { apiBase: string; keyEnv: string; format: "anthropic" | "openai"; defaultModel: string; summarizeModel: string };

const PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: { apiBase: "https://api.anthropic.com/v1", keyEnv: "ANTHROPIC_API_KEY", format: "anthropic", defaultModel: "claude-sonnet-4-5", summarizeModel: "claude-haiku-4-5-20251001" },
  openai: { apiBase: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", format: "openai", defaultModel: "gpt-4o", summarizeModel: "gpt-4o-mini" },
};

const COST_PER_MTOK: Record<string, [number, number]> = {
  "claude-sonnet-4-5": [3, 15], "claude-haiku-4-5-20251001": [0.8, 4],
  "gpt-4o": [2.5, 10], "gpt-4o-mini": [0.15, 0.6],
};

const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", blue: "\x1b[34m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m" };

let provider = PROVIDERS.anthropic;
let model = provider.defaultModel;
const sessionUsage = { inputTokens: 0, outputTokens: 0, usd: 0 };

// --- Types ---
type Tool = { desc: string; params: string[]; summarizable?: boolean; fn: (args: any) => Promise<string> | string };

// --- API Layer (nano-ai) ---
function apiHeaders(): Record<string, string> {
  const key = process.env[provider.keyEnv] ?? "";
  return provider.format === "anthropic"
    ? { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
}

async function apiFetch(path: string, body: object) {
  return fetch(`${provider.apiBase}/${path}`, { method: "POST", headers: apiHeaders(), body: JSON.stringify(body) });
}

function buildToolSchema(tools: Record<string, Tool>) {
  const schemas = Object.entries(tools).map(([name, { desc, params }]) => ({
    name, description: desc,
    input_schema: { type: "object", properties: Object.fromEntries(params.map((p) => [p, { type: "string" }])), required: params },
  }));
  return provider.format === "openai"
    ? schemas.map((s) => ({ type: "function", function: { name: s.name, description: s.description, parameters: s.input_schema } }))
    : schemas;
}

function toOpenAIMessages(messages: any[], systemPrompt: string): any[] {
  const result: any[] = [{ role: "system", content: systemPrompt }];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === "tool_result") result.push({ role: "tool", tool_call_id: item.tool_use_id, content: String(item.content) });
        }
      } else {
        result.push({ role: "user", content: msg.content });
      }
    } else if (msg.role === "assistant") {
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content) }];
      const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      const toolCalls = blocks.filter((b: any) => b.type === "tool_use").map((b: any) => ({
        id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) },
      }));
      const m: any = { role: "assistant", content: text || null };
      if (toolCalls.length > 0) m.tool_calls = toolCalls;
      result.push(m);
    }
  }
  return result;
}

function trackCost(mdl: string, inputTok: number, outputTok: number) {
  sessionUsage.inputTokens += inputTok;
  sessionUsage.outputTokens += outputTok;
  const costs = COST_PER_MTOK[mdl];
  if (costs) sessionUsage.usd += (inputTok * costs[0] + outputTok * costs[1]) / 1_000_000;
}

async function streamAnthropic(messages: any[], systemPrompt: string, tools: Record<string, Tool>, mdl: string) {
  const response = await apiFetch("messages", { model: mdl, max_tokens: 8192, system: systemPrompt, messages, tools: buildToolSchema(tools), stream: true });
  if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);

  const content: any[] = [];
  let stopReason = "", inputTokens = 0, outputTokens = 0;
  let buffer = "", currentBlock: any = null, toolJsonBuf = "", textStarted = false;
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = JSON.parse(line.slice(6));
      if (data.type === "message_start") {
        inputTokens = data.message?.usage?.input_tokens ?? 0;
      } else if (data.type === "content_block_start") {
        currentBlock = data.content_block;
        if (currentBlock.type === "text") textStarted = false;
        else if (currentBlock.type === "tool_use") toolJsonBuf = "";
      } else if (data.type === "content_block_delta") {
        if (data.delta.type === "text_delta") {
          if (!textStarted) { process.stdout.write(`\n${ANSI.cyan}⏺${ANSI.reset} `); textStarted = true; }
          process.stdout.write(data.delta.text);
          currentBlock.text = (currentBlock.text || "") + data.delta.text;
        } else if (data.delta.type === "input_json_delta") {
          toolJsonBuf += data.delta.partial_json;
        }
      } else if (data.type === "content_block_stop") {
        if (currentBlock.type === "tool_use") currentBlock.input = toolJsonBuf ? JSON.parse(toolJsonBuf) : {};
        content.push(currentBlock);
        currentBlock = null;
      } else if (data.type === "message_delta") {
        stopReason = data.delta.stop_reason ?? stopReason;
        outputTokens = data.usage?.output_tokens ?? outputTokens;
      }
    }
  }

  return { content, stop_reason: stopReason || "end_turn", input_tokens: inputTokens, output_tokens: outputTokens };
}

async function streamOpenAI(messages: any[], systemPrompt: string, tools: Record<string, Tool>, mdl: string) {
  const response = await apiFetch("chat/completions", {
    model: mdl, max_completion_tokens: 8192,
    messages: toOpenAIMessages(messages, systemPrompt),
    tools: buildToolSchema(tools), stream: true, stream_options: { include_usage: true },
  });
  if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);

  const content: any[] = [];
  const toolCalls: Record<number, { id: string; name: string; args: string }> = {};
  let textBuf = "", textStarted = false, stopReason = "";
  let inputTokens = 0, outputTokens = 0;
  let buffer = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const data = JSON.parse(line.slice(6));
      if (data.usage) { inputTokens = data.usage.prompt_tokens ?? 0; outputTokens = data.usage.completion_tokens ?? 0; }
      const choice = data.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) stopReason = choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
      if (choice.delta?.content) {
        if (!textStarted) { process.stdout.write(`\n${ANSI.cyan}⏺${ANSI.reset} `); textStarted = true; }
        process.stdout.write(choice.delta.content);
        textBuf += choice.delta.content;
      }
      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          if (!toolCalls[tc.index]) toolCalls[tc.index] = { id: "", name: "", args: "" };
          const entry = toolCalls[tc.index];
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
        }
      }
    }
  }

  if (textBuf) content.push({ type: "text", text: textBuf });
  for (const tc of Object.values(toolCalls)) {
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ? JSON.parse(tc.args) : {} });
  }
  if (!stopReason) stopReason = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";

  return { content, stop_reason: stopReason, input_tokens: inputTokens, output_tokens: outputTokens };
}

async function streamLLM(messages: any[], systemPrompt: string, tools: Record<string, Tool>, mdl?: string) {
  const m = mdl ?? model;
  const result = provider.format === "anthropic"
    ? await streamAnthropic(messages, systemPrompt, tools, m)
    : await streamOpenAI(messages, systemPrompt, tools, m);
  trackCost(m, result.input_tokens, result.output_tokens);
  return result;
}

async function quickLLM(system: string, content: string, mdl?: string): Promise<string> {
  const m = mdl ?? provider.summarizeModel;
  const path = provider.format === "anthropic" ? "messages" : "chat/completions";
  const body = provider.format === "anthropic"
    ? { model: m, max_tokens: 2048, system, messages: [{ role: "user", content }] }
    : { model: m, max_completion_tokens: 2048, messages: [{ role: "system", content: system }, { role: "user", content }] };
  const response = await apiFetch(path, body);
  if (!response.ok) return "";
  const data = await response.json() as any;
  const text = provider.format === "anthropic" ? (data.content?.[0]?.text ?? "") : (data.choices?.[0]?.message?.content ?? "");
  const inTok = data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? 0;
  const outTok = data.usage?.output_tokens ?? data.usage?.completion_tokens ?? 0;
  trackCost(m, inTok, outTok);
  return text;
}

// --- Context Management (nano-agent) ---
async function countTokens(messages: any[], systemPrompt: string): Promise<number> {
  if (provider.format === "anthropic") {
    const response = await apiFetch("messages/count_tokens", { model, system: systemPrompt, messages, tools: buildToolSchema(TOOLS) });
    if (response.ok) return (await response.json() as any).input_tokens;
  }
  return Math.ceil(JSON.stringify({ system: systemPrompt, messages }).length / 4);
}

async function compactMessages(messages: any[]) {
  const splitAt = Math.floor(messages.length * 0.8);
  const recentMessages = messages.slice(splitAt);
  const oldText = messages.slice(0, splitAt).map((m: any) => {
    if (typeof m.content === "string") return `${m.role}: ${m.content}`;
    if (Array.isArray(m.content)) return m.content.map((b: any) =>
      b.type === "text" ? `assistant: ${b.text}` :
      b.type === "tool_use" ? `tool_call: ${b.name}(...)` :
      b.type === "tool_result" ? `tool_result: ${String(b.content).slice(0, 200)}` : ""
    ).join("\n");
    return "";
  }).join("\n");

  const summary = await quickLLM(
    "Summarize this conversation concisely. Preserve: key decisions, files modified, current task state, and any unresolved issues. Output only the summary.",
    oldText,
  );
  if (!summary) return;

  messages.length = 0;
  messages.push({ role: "user", content: `[Conversation summary]\n${summary}` });
  messages.push({ role: "assistant", content: [{ type: "text", text: "Understood. I have the context from our previous conversation. How can I continue helping?" }] });
  messages.push(...recentMessages);
  console.log(`\n${ANSI.dim}⏺ Context compacted${ANSI.reset}`);
}

async function summarizeToolResult(toolName: string, result: string): Promise<string> {
  if (result.split("\n").length < TOOL_SUMMARIZE_THRESHOLD) return result;
  return (await quickLLM(
    `Summarize this ${toolName} tool output concisely. Preserve key details: file structure, important line numbers, function names, error messages, and anything a coding assistant would need. Output only the summary.`,
    result,
  )) || result;
}

async function loadSystemPrompt(): Promise<string> {
  let prompt = `Concise coding assistant. cwd: ${process.cwd()}`;
  try { prompt += "\n\n" + await readFile(`${process.env.HOME}/.nanocode/AGENTS.md`, "utf-8"); } catch {}
  try { prompt += "\n\n" + await readFile("AGENTS.md", "utf-8"); } catch {}
  return prompt;
}

async function saveSession(name: string, messages: any[]) {
  await mkdir(SESSIONS_DIR, { recursive: true });
  await writeFile(`${SESSIONS_DIR}/${name}.jsonl`, messages.map((m) => JSON.stringify(m)).join("\n"), "utf-8");
}

async function loadSessionMessages(name: string): Promise<any[]> {
  return (await readFile(`${SESSIONS_DIR}/${name}.jsonl`, "utf-8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function listSessions(): Promise<string[]> {
  try { return (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith(".jsonl")).map((f) => f.replace(".jsonl", "")); }
  catch { return []; }
}

// --- Tools (nano-coding-agent) ---
const TOOLS: Record<string, Tool> = {
  read: {
    desc: "Read file with line numbers", params: ["path"], summarizable: true,
    fn: async (args) => {
      const lines = (await readFile(args.path, "utf-8")).split("\n");
      const start = args.offset ?? 0;
      const end = start + (args.limit ?? lines.length);
      return lines.slice(start, end).map((line: string, i: number) => `${String(start + i + 1).padStart(4)}| ${line}`).join("\n");
    },
  },
  write: {
    desc: "Write content to file", params: ["path", "content"],
    fn: async (args) => { await writeFile(args.path, args.content, "utf-8"); return "ok"; },
  },
  edit: {
    desc: "Replace old with new in file", params: ["path", "old", "new"],
    fn: async (args) => {
      const content = await readFile(args.path, "utf-8");
      await writeFile(args.path, args.all ? content.split(args.old).join(args.new) : content.replace(args.old, args.new), "utf-8");
      return "ok";
    },
  },
  glob: {
    desc: "Find files by pattern", params: ["pat"],
    fn: async (args) => (await Array.fromAsync(new Bun.Glob(`${args.path ?? "."}/${args.pat}`).scan())).join("\n") || "none",
  },
  grep: {
    desc: "Search files for regex", params: ["pat"], summarizable: true,
    fn: async (args) => {
      const pattern = new RegExp(args.pat);
      const hits: string[] = [];
      for await (const file of new Bun.Glob(`${args.path ?? "."}/**`).scan()) {
        if (file.includes("node_modules")) continue;
        const content = await readFile(file, "utf-8");
        content.split("\n").forEach((line: string, i: number) => {
          if (pattern.test(line)) hits.push(`${file}:${i + 1}:${line.trim()}`);
        });
      }
      return hits.slice(0, 50).join("\n") || "none";
    },
  },
  multiedit: {
    desc: "Apply multiple find-and-replace edits to a file in one operation. Edits is a JSON array of {old, new} pairs applied sequentially.",
    params: ["path", "edits"],
    fn: async (args) => {
      let content = await readFile(args.path, "utf-8");
      const edits = typeof args.edits === "string" ? JSON.parse(args.edits) : args.edits;
      for (const { old: o, new: n } of edits) content = content.replace(o, n);
      await writeFile(args.path, content, "utf-8");
      return "ok";
    },
  },
  websearch: {
    desc: "Search the web and return results", params: ["query"], summarizable: true,
    fn: async (args) => {
      const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`);
      if (!response.ok) throw new Error(`Search failed: ${response.status}`);
      const html = await response.text();
      const results = [...html.matchAll(/<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>(.+?)<\/a>/g)]
        .slice(0, 10).map((m) => `${m[2].replace(/<[^>]+>/g, "")} - ${m[1]}`);
      return results.join("\n") || "no results";
    },
  },
  webfetch: {
    desc: "Fetch a URL and return its content as markdown", params: ["url"],
    fn: async (args) => {
      const response = await fetch(args.url);
      if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
      const html = await response.text();
      // Convert HTML to markdown-like text
      let md = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi, (_: string, level: string, text: string) => `${"#".repeat(Number(level))} ${text.replace(/<[^>]+>/g, "")}\n`)
        .replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
        .replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi, "**$2**")
        .replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gi, "*$2*")
        .replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`")
        .replace(/<pre[^>]*>(.*?)<\/pre>/gis, "```\n$1\n```\n")
        .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<p[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
        .replace(/\n{3,}/g, "\n\n").trim();
      // Summarize via inner LLM if large
      if (md.length > 10000) {
        const summary = await quickLLM(
          "Summarize this web page content. Preserve key information, code examples, and important details. Output only the summary in markdown.",
          md.slice(0, 50000),
        );
        if (summary) return summary;
      }
      return md;
    },
  },
  bash: {
    desc: "Run shell command", params: ["cmd"], summarizable: true,
    fn: (args) => execSync(args.cmd, { encoding: "utf-8", timeout: 30000 }).trim(),
  },
  subagent: {
    desc: "Delegate a research task to a sub-agent with its own context window. Use for multi-step investigations.",
    params: ["task"],
    fn: async (args) => await runAgentLoop(
      [{ role: "user", content: args.task }],
      `Concise coding assistant. cwd: ${process.cwd()}. You are a sub-agent. Use tools to investigate, then provide a clear final answer.`,
      { compact: false, summarizeTools: false },
    ),
  },
};

// --- Agent Loop (nano-agent) ---
interface AgentOptions { compact?: boolean; summarizeTools?: boolean }

async function runAgentLoop(messages: any[], systemPrompt: string, opts: AgentOptions = {}): Promise<string> {
  const { compact = true, summarizeTools = true } = opts;
  let lastText = "";

  while (true) {
    if (compact) {
      const tokens = await countTokens(messages, systemPrompt);
      if (tokens > COMPACT_THRESHOLD) await compactMessages(messages);
    }

    const response = await streamLLM(messages, systemPrompt, TOOLS);
    messages.push({ role: "assistant", content: response.content });
    lastText = response.content.find((b: any) => b.type === "text")?.text ?? lastText;
    if (response.stop_reason !== "tool_use") break;

    const toolResults = await Promise.all(
      response.content.filter((b: any) => b.type === "tool_use").map(async (block: any) => {
        const preview = String(Object.values(block.input)[0] ?? "").slice(0, 50);
        console.log(`\n${ANSI.green}⏺ ${block.name}${ANSI.reset}(${ANSI.dim}${preview}${ANSI.reset})`);
        try {
          let result = await (TOOLS[block.name]?.fn(block.input) ?? `unknown tool: ${block.name}`);
          if (summarizeTools && TOOLS[block.name]?.summarizable) result = await summarizeToolResult(block.name, result);
          console.log(`  ${ANSI.dim}⎿  ${result.split("\n")[0].slice(0, 60)}${result.includes("\n") ? ` +${result.split("\n").length - 1} lines` : ""}${ANSI.reset}`);
          return { type: "tool_result", tool_use_id: block.id, content: result };
        } catch (err: any) {
          return { type: "tool_result", tool_use_id: block.id, content: String(err), is_error: true };
        }
      }),
    );
    messages.push({ role: "user", content: toolResults });
  }

  return lastText;
}

// --- Main (nano-coding-agent) ---
async function main() {
  const systemPrompt = await loadSystemPrompt();

  console.log(`
${ANSI.bold}${ANSI.cyan}
 ███╗   ██╗ █████╗ ███╗   ██╗ ██████╗  ██████╗ ██████╗ ██████╗ ███████╗
 ████╗  ██║██╔══██╗████╗  ██║██╔═══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝
 ██╔██╗ ██║███████║██╔██╗ ██║██║   ██║██║     ██║   ██║██║  ██║█████╗
 ██║╚██╗██║██╔══██║██║╚██╗██║██║   ██║██║     ██║   ██║██║  ██║██╔══╝
 ██║ ╚████║██║  ██║██║ ╚████║╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗
 ╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
${ANSI.reset}
${ANSI.dim}nanocode${ANSI.reset} | ${ANSI.dim}${model}${ANSI.reset} | ${ANSI.dim}${process.cwd()}${ANSI.reset}
`);

  const messages: any[] = [];
  const separator = () => console.log(`${ANSI.dim}${"─".repeat(80)}${ANSI.reset}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    separator();
    const input = await new Promise<string>((resolve) => {
      rl.question(`${ANSI.bold}${ANSI.blue}❯${ANSI.reset} `, (answer: string) => resolve(answer.trim()));
    });
    separator();
    if (!input) continue;
    if (input === "/q" || input === "exit") break;
    if (input === "/c") { messages.length = 0; console.log(`${ANSI.green}⏺ Cleared${ANSI.reset}`); continue; }
    if (input === "/cost") {
      console.log(`${ANSI.dim}Tokens: ${sessionUsage.inputTokens.toLocaleString()} in / ${sessionUsage.outputTokens.toLocaleString()} out | Cost: $${sessionUsage.usd.toFixed(4)}${ANSI.reset}`);
      continue;
    }
    if (input === "/sessions") {
      const sessions = await listSessions();
      console.log(sessions.length ? sessions.join("\n") : "No saved sessions");
      continue;
    }
    if (input.startsWith("/save ")) {
      const name = input.slice(6).trim();
      if (name) { await saveSession(name, messages); console.log(`${ANSI.green}⏺ Saved: ${name}${ANSI.reset}`); }
      continue;
    }
    if (input.startsWith("/load ")) {
      const name = input.slice(6).trim();
      try {
        const loaded = await loadSessionMessages(name);
        messages.length = 0; messages.push(...loaded);
        console.log(`${ANSI.green}⏺ Loaded: ${name} (${loaded.length} messages)${ANSI.reset}`);
      } catch { console.log(`${ANSI.red}Session not found: ${name}${ANSI.reset}`); }
      continue;
    }
    if (input.startsWith("/model ")) {
      const arg = input.slice(7).trim();
      const [p, m] = arg.includes(":") ? arg.split(":") : [null, arg];
      if (p && PROVIDERS[p]) { provider = PROVIDERS[p]; model = m || provider.defaultModel; }
      else if (p) { console.log(`${ANSI.red}Unknown provider: ${p}. Available: ${Object.keys(PROVIDERS).join(", ")}${ANSI.reset}`); continue; }
      else { model = m; }
      console.log(`${ANSI.green}⏺ Model: ${model}${ANSI.reset}`);
      continue;
    }

    messages.push({ role: "user", content: input });
    await runAgentLoop(messages, systemPrompt);
    console.log();
  }
  rl.close();
}

main().catch((e) => { console.error(`${ANSI.red}Fatal: ${e}${ANSI.reset}`); process.exit(1); });
