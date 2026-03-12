#!/usr/bin/env bun
/** nanocode - minimal deep coding agent with gateway, memory, extensions, and sandboxing */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";

// --- Config ---
const COMPACT_THRESHOLD = 150000;
const TOOL_SUMMARIZE_THRESHOLD = 200;
const NANOCODE_DIR = `${process.env.HOME}/.nanocode`;
const SESSIONS_DIR = `${NANOCODE_DIR}/sessions`;
const MEMORY_DIR = `${NANOCODE_DIR}/memory`;
const EXTENSIONS_DIRS = [`${NANOCODE_DIR}/extensions`, ".nanocode/extensions"];
const GATEWAY_PORT = Number(process.env.NANOCODE_GATEWAY_PORT ?? 18789);
const GATEWAY_HOST = "127.0.0.1";
const MEMORY_INJECTION_MAX_TOKENS = 4000;
const MEMORY_RELEVANCE_THRESHOLD = 0.3; // min FTS5 rank score

type ProviderConfig = { apiBase: string; keyEnv: string; format: "anthropic" | "openai"; defaultModel: string; summarizeModel: string };

const PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: { apiBase: "https://api.anthropic.com/v1", keyEnv: "ANTHROPIC_API_KEY", format: "anthropic", defaultModel: "claude-sonnet-4-5", summarizeModel: "claude-haiku-4-5-20251001" },
  openai: { apiBase: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", format: "openai", defaultModel: "gpt-4o", summarizeModel: "gpt-4o-mini" },
};

const COST_PER_MTOK: Record<string, [number, number]> = {
  "claude-sonnet-4-5": [3, 15], "claude-haiku-4-5-20251001": [0.8, 4],
  "gpt-4o": [2.5, 10], "gpt-4o-mini": [0.15, 0.6],
};

const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", blue: "\x1b[34m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m" };

// --- Types ---
type SessionType = "main" | "dm" | "group";
type OutputSink = { write(text: string): void; log(text: string): void };
type Tool = { desc: string; params: string[]; summarizable?: boolean; mainOnly?: boolean; fn: (args: any, session?: SessionState) => Promise<string> | string };
type HookFn = (data: any) => Promise<void> | void;

interface SessionState {
  id: string;
  type: SessionType;
  messages: any[];
  provider: ProviderConfig;
  model: string;
  usage: { inputTokens: number; outputTokens: number; usd: number };
  cwd: string;
  containerId?: string;
  running: boolean;
  queue: string[];
}

interface TreeEntry {
  id: string;
  parentId: string | null;
  type: "message" | "compaction" | "branch" | "meta";
  timestamp: number;
  role?: string;
  content?: any;
}

interface GatewayMessage {
  type: string;
  source?: { platform: string; channel: string; user: string; threadTs?: string };
  text?: string;
  sessionId?: string;
  idempotencyKey?: string;
  media?: { url: string; mimeType: string; filename?: string }[];
  password?: string;
}

// Gateway JSON Schema validation
const GATEWAY_SCHEMA: Record<string, { required: string[]; optional: string[] }> = {
  heartbeat: { required: ["type"], optional: ["idempotencyKey"] },
  message: { required: ["type", "source", "text"], optional: ["idempotencyKey", "sessionId", "media"] },
  subscribe: { required: ["type"], optional: ["idempotencyKey", "sessionId"] },
  auth: { required: ["type"], optional: ["password", "challenge", "signature"] },
};

function validateGatewayMessage(raw: string): GatewayMessage {
  let msg: any;
  try { msg = JSON.parse(raw); } catch { throw new Error("Invalid JSON"); }
  if (typeof msg.type !== "string") throw new Error("Missing 'type' field");
  const schema = GATEWAY_SCHEMA[msg.type];
  if (!schema) throw new Error(`Unknown message type: ${msg.type}`);
  for (const field of schema.required) {
    if (msg[field] === undefined) throw new Error(`Missing required field: ${field}`);
  }
  const allowed = new Set([...schema.required, ...schema.optional]);
  for (const key of Object.keys(msg)) {
    if (!allowed.has(key)) throw new Error(`Unknown field: ${key}`);
  }
  if (msg.source) {
    for (const f of ["platform", "channel", "user"]) {
      if (typeof msg.source[f] !== "string") throw new Error(`source.${f} must be a string`);
    }
  }
  return msg as GatewayMessage;
}

// --- Output sinks ---
const stdoutSink: OutputSink = { write: (t) => process.stdout.write(t), log: (t) => console.log(t) };
const nullSink: OutputSink = { write: () => {}, log: () => {} };

function wsSink(ws: any, sessionId: string): OutputSink {
  return {
    write: (t) => { try { ws.send(JSON.stringify({ type: "stream_delta", sessionId, text: t })); } catch {} },
    log: (t) => { try { ws.send(JSON.stringify({ type: "log", sessionId, text: t })); } catch {} },
  };
}

// --- Session registry ---
const sessions = new Map<string, SessionState>();

function createSession(id: string, type: SessionType, opts: { provider?: ProviderConfig; model?: string; cwd?: string } = {}): SessionState {
  const prov = opts.provider ?? PROVIDERS.anthropic;
  const session: SessionState = {
    id, type,
    messages: [],
    provider: prov,
    model: opts.model ?? prov.defaultModel,
    usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
    cwd: opts.cwd ?? process.cwd(),
    running: false,
    queue: [],
  };
  sessions.set(id, session);
  fireHook("session_start", { session });
  return session;
}

function getOrCreateSession(id: string, type: SessionType): SessionState {
  return sessions.get(id) ?? createSession(id, type);
}

// --- API Layer ---
function apiHeaders(prov: ProviderConfig): Record<string, string> {
  const key = process.env[prov.keyEnv] ?? "";
  return prov.format === "anthropic"
    ? { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
}

async function apiFetch(prov: ProviderConfig, path: string, body: object) {
  return fetch(`${prov.apiBase}/${path}`, { method: "POST", headers: apiHeaders(prov), body: JSON.stringify(body) });
}

function buildToolSchema(tools: Record<string, Tool>, prov: ProviderConfig) {
  const schemas = Object.entries(tools).map(([name, { desc, params }]) => ({
    name, description: desc,
    input_schema: { type: "object", properties: Object.fromEntries(params.map((p) => [p, { type: "string" }])), required: params },
  }));
  return prov.format === "openai"
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

function trackCost(usage: SessionState["usage"], mdl: string, inputTok: number, outputTok: number) {
  usage.inputTokens += inputTok;
  usage.outputTokens += outputTok;
  const costs = COST_PER_MTOK[mdl];
  if (costs) usage.usd += (inputTok * costs[0] + outputTok * costs[1]) / 1_000_000;
}

async function streamAnthropic(messages: any[], systemPrompt: string, tools: Record<string, Tool>, session: SessionState, sink: OutputSink) {
  const response = await apiFetch(session.provider, "messages", {
    model: session.model, max_tokens: 8192, system: systemPrompt, messages, tools: buildToolSchema(tools, session.provider), stream: true,
  });
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
          if (!textStarted) { sink.write(`\n${ANSI.cyan}⏺${ANSI.reset} `); textStarted = true; }
          sink.write(data.delta.text);
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

async function streamOpenAI(messages: any[], systemPrompt: string, tools: Record<string, Tool>, session: SessionState, sink: OutputSink) {
  const response = await apiFetch(session.provider, "chat/completions", {
    model: session.model, max_completion_tokens: 8192,
    messages: toOpenAIMessages(messages, systemPrompt),
    tools: buildToolSchema(tools, session.provider), stream: true, stream_options: { include_usage: true },
  });
  if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);

  const content: any[] = [];
  const toolCalls: Record<number, { id: string; name: string; args: string }> = {};
  let textBuf = "", textStarted = false, stopReason = "";
  let inputTokens = 0, outputTokens = 0, buffer = "";
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
        if (!textStarted) { sink.write(`\n${ANSI.cyan}⏺${ANSI.reset} `); textStarted = true; }
        sink.write(choice.delta.content);
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
  for (const tc of Object.values(toolCalls)) content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ? JSON.parse(tc.args) : {} });
  if (!stopReason) stopReason = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  return { content, stop_reason: stopReason, input_tokens: inputTokens, output_tokens: outputTokens };
}

async function streamLLM(messages: any[], systemPrompt: string, tools: Record<string, Tool>, session: SessionState, sink: OutputSink) {
  const result = session.provider.format === "anthropic"
    ? await streamAnthropic(messages, systemPrompt, tools, session, sink)
    : await streamOpenAI(messages, systemPrompt, tools, session, sink);
  trackCost(session.usage, session.model, result.input_tokens, result.output_tokens);
  return result;
}

async function quickLLM(prov: ProviderConfig, system: string, content: string, mdl?: string): Promise<string> {
  const m = mdl ?? prov.summarizeModel;
  const path = prov.format === "anthropic" ? "messages" : "chat/completions";
  const body = prov.format === "anthropic"
    ? { model: m, max_tokens: 2048, system, messages: [{ role: "user", content }] }
    : { model: m, max_completion_tokens: 2048, messages: [{ role: "system", content: system }, { role: "user", content }] };
  const response = await apiFetch(prov, path, body);
  if (!response.ok) return "";
  const data = await response.json() as any;
  return prov.format === "anthropic" ? (data.content?.[0]?.text ?? "") : (data.choices?.[0]?.message?.content ?? "");
}

// --- Context Management ---
async function countTokens(messages: any[], systemPrompt: string, session: SessionState): Promise<number> {
  if (session.provider.format === "anthropic") {
    const response = await apiFetch(session.provider, "messages/count_tokens", { model: session.model, system: systemPrompt, messages, tools: buildToolSchema(TOOLS, session.provider) });
    if (response.ok) return (await response.json() as any).input_tokens;
  }
  return Math.ceil(JSON.stringify({ system: systemPrompt, messages }).length / 4);
}

async function compactMessages(messages: any[], session: SessionState) {
  const splitAt = Math.floor(messages.length * 0.8);
  const recentMessages = messages.slice(splitAt);
  const oldMessages = messages.slice(0, splitAt);

  // Memory flush: extract durable facts before discarding
  await memoryFlush(oldMessages, session);
  await fireHook("session_before_compact", { session, oldMessages });

  const oldText = oldMessages.map((m: any) => {
    if (typeof m.content === "string") return `${m.role}: ${m.content}`;
    if (Array.isArray(m.content)) return m.content.map((b: any) =>
      b.type === "text" ? `assistant: ${b.text}` :
      b.type === "tool_use" ? `tool_call: ${b.name}(...)` :
      b.type === "tool_result" ? `tool_result: ${String(b.content).slice(0, 200)}` : ""
    ).join("\n");
    return "";
  }).join("\n");

  const summary = await quickLLM(session.provider,
    "Summarize this conversation concisely. Preserve: key decisions, files modified, current task state, and any unresolved issues. Output only the summary.",
    oldText,
  );
  if (!summary) return;

  messages.length = 0;
  messages.push({ role: "user", content: `[Conversation summary]\n${summary}` });
  messages.push({ role: "assistant", content: [{ type: "text", text: "Understood. I have the context from our previous conversation. How can I continue helping?" }] });
  messages.push(...recentMessages);
  await fireHook("session_compact", { session });
}

async function summarizeToolResult(toolName: string, result: string, session: SessionState): Promise<string> {
  if (result.split("\n").length < TOOL_SUMMARIZE_THRESHOLD) return result;
  return (await quickLLM(session.provider,
    `Summarize this ${toolName} tool output concisely. Preserve key details: file structure, important line numbers, function names, error messages, and anything a coding assistant would need. Output only the summary.`,
    result,
  )) || result;
}

async function loadSystemPrompt(session: SessionState): Promise<string> {
  let prompt = `Concise coding assistant. cwd: ${session.cwd}`;
  try { prompt += "\n\n" + await readFile(`${NANOCODE_DIR}/AGENTS.md`, "utf-8"); } catch {}
  try { prompt += "\n\n" + await readFile("AGENTS.md", "utf-8"); } catch {}

  // Load MEMORY.md for main sessions only (privacy)
  if (session.type === "main") {
    try { prompt += "\n\n## Long-term Memory\n" + await readFile(`${NANOCODE_DIR}/MEMORY.md`, "utf-8"); } catch {}
  }

  // Inject relevant memories with token budget
  if (memoryDb) {
    const lastUserMsg = [...session.messages].reverse().find((m: any) => m.role === "user" && typeof m.content === "string");
    if (lastUserMsg) {
      const memories = await memorySearchSemantic(lastUserMsg.content, 10);
      if (memories.length) {
        let injected = "\n\n## Relevant Memories\n";
        let tokenBudget = MEMORY_INJECTION_MAX_TOKENS;
        for (const mem of memories) {
          const memTokens = Math.ceil(mem.length / 4);
          if (memTokens > tokenBudget) break;
          injected += mem + "\n---\n";
          tokenBudget -= memTokens;
        }
        prompt += injected;
      }
    }
  }

  // Session type context
  if (session.type === "dm") prompt += "\n\nYou are in a DM session. Your tools are restricted for safety.";
  if (session.type === "group") prompt += "\n\nYou are in a group session. Your tools are restricted for safety.";

  // Extension hooks can modify context
  const ctx = { prompt, session };
  await fireHook("context_before_send", ctx);
  return ctx.prompt;
}

// --- Session Persistence (tree-structured JSONL) ---
function sessionPath(sessionId: string): string {
  return `${SESSIONS_DIR}/${sessionId.replace(/[/:]/g, "_")}.jsonl`;
}

async function appendSessionEntry(sessionId: string, entry: Partial<TreeEntry> & { role?: string; content?: any }) {
  const full: TreeEntry = { id: randomUUID(), parentId: null, type: "message", timestamp: Date.now(), ...entry };
  await mkdir(SESSIONS_DIR, { recursive: true });
  const path = sessionPath(sessionId);
  const line = JSON.stringify(full) + "\n";
  try { const existing = await readFile(path, "utf-8"); await writeFile(path, existing + line, "utf-8"); }
  catch { await writeFile(path, line, "utf-8"); }
  return full.id;
}

async function loadSessionTree(sessionId: string): Promise<TreeEntry[]> {
  try {
    const lines = (await readFile(sessionPath(sessionId), "utf-8")).split("\n").filter(Boolean);
    return lines.map((l: string) => JSON.parse(l));
  } catch { return []; }
}

async function getSessionMessages(sessionId: string): Promise<any[]> {
  const entries = await loadSessionTree(sessionId);
  // Find the active branch (follow from last entry back through parentIds)
  const messageEntries = entries.filter((e) => e.type === "message" && e.role && e.content);
  return messageEntries.map((e) => ({ role: e.role, content: e.content }));
}

async function forkSession(sessionId: string, label?: string): Promise<string> {
  const forkId = `${sessionId}_fork_${Date.now()}`;
  await appendSessionEntry(sessionId, { type: "branch", content: { forkId, label: label ?? "fork" } } as any);
  // Copy current messages to new session
  const session = sessions.get(sessionId);
  if (session) {
    const forked = createSession(forkId, session.type, { provider: session.provider, model: session.model, cwd: session.cwd });
    forked.messages.push(...session.messages);
  }
  return forkId;
}

async function saveSession(sessionId: string, messages: any[]) {
  await mkdir(SESSIONS_DIR, { recursive: true });
  await writeFile(sessionPath(sessionId), messages.map((m: any) => JSON.stringify({ id: randomUUID(), parentId: null, type: "message", timestamp: Date.now(), role: m.role, content: m.content })).join("\n") + "\n", "utf-8");
}

async function listSessionNames(): Promise<string[]> {
  try { return (await readdir(SESSIONS_DIR)).filter((f: string) => f.endsWith(".jsonl")).map((f: string) => f.replace(".jsonl", "")); }
  catch { return []; }
}

function sessionTree(entries: TreeEntry[]): string {
  if (!entries.length) return "Empty session";
  return entries.map((e, i) => {
    const prefix = e.type === "branch" ? "├─ [FORK]" : e.type === "compaction" ? "├─ [COMPACT]" : `├─ ${e.role ?? "?"}`;
    const preview = typeof e.content === "string" ? e.content.slice(0, 60) : e.type === "branch" ? (e.content as any)?.label ?? "" : "...";
    return `${String(i + 1).padStart(3)}. ${prefix}: ${preview}`;
  }).join("\n");
}

// --- Memory System ---
let memoryDb: Database | null = null;
let memoryWatcher: ReturnType<typeof setTimeout> | null = null;

async function initMemory() {
  try {
    await mkdir(MEMORY_DIR, { recursive: true });
    memoryDb = new Database(`${MEMORY_DIR}/agent.sqlite`);
    memoryDb.run("CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, content TEXT, tags TEXT, source TEXT, timestamp INTEGER)");
    memoryDb.run("CREATE TABLE IF NOT EXISTS embeddings (memory_id TEXT PRIMARY KEY, vector BLOB, provider TEXT)");
    try { memoryDb.run("CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags)"); } catch {}
    startMemoryWatcher();
  } catch { memoryDb = null; }
}

// Vector embeddings: auto-detect provider
async function getEmbedding(text: string): Promise<Float32Array | null> {
  // Try OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 8000) }),
      });
      if (res.ok) {
        const data = await res.json() as any;
        return new Float32Array(data.data[0].embedding);
      }
    } catch {}
  }
  // Try Gemini
  if (process.env.GEMINI_API_KEY) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${process.env.GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: { parts: [{ text: text.slice(0, 8000) }] } }),
      });
      if (res.ok) {
        const data = await res.json() as any;
        return new Float32Array(data.embedding.values);
      }
    } catch {}
  }
  return null;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; magA += a[i] * a[i]; magB += b[i] * b[i]; }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

function memorySave(content: string, tags: string = "", source: string = "agent") {
  if (!memoryDb) return;
  const id = randomUUID();
  const ts = Date.now();
  memoryDb.run("INSERT INTO memories (id, content, tags, source, timestamp) VALUES (?, ?, ?, ?, ?)", [id, content, tags, source, ts]);
  try { memoryDb.run("INSERT INTO memories_fts (content, tags) VALUES (?, ?)", [content, tags]); } catch {}
  // Async: generate embedding
  getEmbedding(content).then((vec) => {
    if (vec && memoryDb) {
      memoryDb.run("INSERT OR REPLACE INTO embeddings (memory_id, vector, provider) VALUES (?, ?, ?)", [id, Buffer.from(vec.buffer), "auto"]);
    }
  }).catch(() => {});
}

function memorySearch(query: string, limit: number = 5): string[] {
  if (!memoryDb) return [];
  try {
    // FTS5 search with relevance threshold
    const results = memoryDb.prepare("SELECT content, rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?").all(query, limit * 2) as any[];
    return results.filter((r: any) => Math.abs(r.rank) >= MEMORY_RELEVANCE_THRESHOLD).slice(0, limit).map((r: any) => r.content);
  } catch {
    const results = memoryDb.prepare("SELECT content FROM memories WHERE content LIKE ? ORDER BY timestamp DESC LIMIT ?").all(`%${query}%`, limit) as any[];
    return results.map((r: any) => r.content);
  }
}

async function memorySearchSemantic(query: string, limit: number = 5): Promise<string[]> {
  if (!memoryDb) return [];
  const queryVec = await getEmbedding(query);
  if (!queryVec) return memorySearch(query, limit); // fallback to FTS

  const rows = memoryDb.prepare("SELECT e.memory_id, e.vector, m.content FROM embeddings e JOIN memories m ON e.memory_id = m.id").all() as any[];
  const scored = rows.map((r: any) => {
    const vec = new Float32Array(new Uint8Array(r.vector).buffer);
    return { content: r.content, score: cosineSimilarity(queryVec, vec) };
  }).filter((r) => r.score >= MEMORY_RELEVANCE_THRESHOLD).sort((a, b) => b.score - a.score).slice(0, limit);

  return scored.map((r) => r.content);
}

// File watcher on memory files with 1.5s debounce for reindexing
function startMemoryWatcher() {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const reindex = async () => {
    if (!memoryDb) return;
    try {
      const files = await readdir(MEMORY_DIR);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        try {
          const content = await readFile(`${MEMORY_DIR}/${file}`, "utf-8");
          const existing = memoryDb.prepare("SELECT id FROM memories WHERE source = ?").get(`file:${file}`) as any;
          if (existing) {
            memoryDb.run("UPDATE memories SET content = ?, timestamp = ? WHERE id = ?", [content, Date.now(), existing.id]);
          } else {
            memorySave(content, file.replace(".md", ""), `file:${file}`);
          }
        } catch {}
      }
    } catch {}
  };

  // Use Bun.file watcher if available, otherwise poll
  try {
    const { watch } = require("node:fs");
    watch(MEMORY_DIR, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(reindex, 1500);
    });
  } catch {
    // Fallback: poll every 30 seconds
    setInterval(reindex, 30000);
  }
}

async function memoryFlush(oldMessages: any[], session: SessionState) {
  if (!memoryDb) return;
  const text = oldMessages.map((m: any) => typeof m.content === "string" ? m.content : "").filter(Boolean).join("\n").slice(0, 5000);
  if (!text) return;
  const facts = await quickLLM(session.provider,
    "Extract key facts from this conversation that should be remembered long-term: decisions made, files modified, user preferences, project details. Output as a bullet list. Be concise.",
    text,
  );
  if (facts) {
    memorySave(facts, "auto-flush", `session:${session.id}`);
    // Append to daily log
    const date = new Date().toISOString().split("T")[0];
    const logPath = `${MEMORY_DIR}/${date}.md`;
    try {
      const existing = await readFile(logPath, "utf-8");
      await writeFile(logPath, existing + `\n\n## ${new Date().toISOString()}\n${facts}`, "utf-8");
    } catch {
      await mkdir(MEMORY_DIR, { recursive: true });
      await writeFile(logPath, `# ${date}\n\n## ${new Date().toISOString()}\n${facts}`, "utf-8");
    }
  }
}

// --- Extension System ---
const hooks = new Map<string, HookFn[]>();
const extCommands = new Map<string, (args: string, session: SessionState, sink: OutputSink) => Promise<void>>();
const extShortcuts = new Map<string, () => Promise<void>>();
const extFlags = new Map<string, { description: string; default?: string; value?: string }>();

async function fireHook(event: string, data: any) {
  for (const fn of hooks.get(event) ?? []) { try { await fn(data); } catch {} }
}

function createExtensionAPI(session: SessionState): any {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    registerTool: (name: string, tool: Tool) => { TOOLS[name] = tool; },
    registerCommand: (name: string, handler: any) => { extCommands.set(name, handler); },
    registerShortcut: (key: string, handler: () => Promise<void>) => { extShortcuts.set(key, handler); },
    registerFlag: (name: string, config: { description: string; default?: string }) => { extFlags.set(name, config); },
    registerHook: (event: string, handler: HookFn) => { hooks.set(event, [...(hooks.get(event) ?? []), handler]); },
    getSession: () => session,
    getFlag: (name: string) => extFlags.get(name)?.value ?? extFlags.get(name)?.default,
    appendEntry: (type: string, data: any) => appendSessionEntry(session.id, { type: type as any, content: data }),
    log: (msg: string) => console.log(msg),
    // User interaction
    confirm: (message: string): Promise<boolean> => new Promise((resolve) => {
      rl.question(`${ANSI.yellow}? ${message} (y/n)${ANSI.reset} `, (a: string) => resolve(a.trim().toLowerCase() === "y"));
    }),
    select: (message: string, options: string[]): Promise<string | null> => new Promise((resolve) => {
      console.log(`${ANSI.yellow}? ${message}${ANSI.reset}`);
      options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
      rl.question(`${ANSI.yellow}> ${ANSI.reset}`, (a: string) => {
        const idx = parseInt(a.trim(), 10) - 1;
        resolve(idx >= 0 && idx < options.length ? options[idx] : null);
      });
    }),
    notify: (message: string) => { console.log(`${ANSI.cyan}⏺ ${message}${ANSI.reset}`); },
  };
}

async function loadExtensions(session: SessionState) {
  for (const dir of EXTENSIONS_DIRS) {
    if (!existsSync(dir)) continue;
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
        try {
          const mod = await import(`${dir}/${file}`);
          const init = mod.default ?? mod.init;
          if (typeof init === "function") await init(createExtensionAPI(session));
        } catch (e) { console.log(`${ANSI.dim}Extension load failed: ${file}: ${e}${ANSI.reset}`); }
      }
    } catch {}
  }
}

// --- Security & Sandboxing ---
type PolicyRule = { tool: string; allow: boolean };

const DEFAULT_POLICIES: Record<SessionType, PolicyRule[]> = {
  main: [],
  dm: [{ tool: "bash", allow: false }, { tool: "write", allow: false }, { tool: "edit", allow: false }, { tool: "multiedit", allow: false }],
  group: [{ tool: "bash", allow: false }, { tool: "write", allow: false }, { tool: "edit", allow: false }, { tool: "multiedit", allow: false }],
};

// Layered policy chain: Tool Profile > Provider Profile > Global Policy > Provider Policy > Agent Policy > Group Policy > Sandbox Policy
// Each layer can override the previous. Last matching rule wins.
function isToolAllowed(toolName: string, session: SessionState): boolean {
  const rules: PolicyRule[] = [];

  // Load policy file
  let policy: any = {};
  try { policy = JSON.parse(require("fs").readFileSync(`${NANOCODE_DIR}/policy.json`, "utf-8")); } catch {}

  // Layer 1: Tool-specific profile
  if (policy.toolProfiles?.[toolName]) rules.push(...policy.toolProfiles[toolName]);
  // Layer 2: Provider profile
  const provName = Object.entries(PROVIDERS).find(([_, p]) => p === session.provider)?.[0] ?? "";
  if (policy.providerProfiles?.[provName]) rules.push(...policy.providerProfiles[provName]);
  // Layer 3: Global policy
  if (policy.global) rules.push(...policy.global);
  // Layer 4: Provider policy (per-provider rules)
  if (policy.providers?.[provName]) rules.push(...policy.providers[provName]);
  // Layer 5: Agent policy
  if (policy.agent) rules.push(...policy.agent);
  // Layer 6: Group/session type policy
  rules.push(...(DEFAULT_POLICIES[session.type] ?? []));
  if (policy[session.type]) rules.push(...policy[session.type]);
  // Layer 7: Sandbox policy (most specific, wins)
  if (session.containerId && policy.sandbox?.tools) rules.push(...policy.sandbox.tools);

  const matching = rules.filter((r: PolicyRule) => r.tool === toolName);
  if (matching.length === 0) return true;
  return matching[matching.length - 1].allow;
}

function filterToolsForSession(tools: Record<string, Tool>, session: SessionState): Record<string, Tool> {
  return Object.fromEntries(
    Object.entries(tools).filter(([name, tool]) => {
      if (tool.mainOnly && session.type !== "main") return false;
      return isToolAllowed(name, session);
    })
  );
}

let dockerAvailable: boolean | null = null;

function checkDocker(): boolean {
  if (dockerAvailable !== null) return dockerAvailable;
  try { execSync("docker info", { stdio: "ignore", timeout: 5000 }); dockerAvailable = true; }
  catch { dockerAvailable = false; }
  return dockerAvailable;
}

// Sandbox network config: per-session via policy or env
function sandboxNetworkFlag(sessionId: string): string {
  try {
    const policy = JSON.parse(require("fs").readFileSync(`${NANOCODE_DIR}/policy.json`, "utf-8"));
    if (policy.sandbox?.network === true) return "";
    if (policy.sandbox?.networkSessions?.includes(sessionId)) return "";
  } catch {}
  return process.env.NANOCODE_SANDBOX_NETWORK === "true" ? "" : "--network none";
}

function createSandbox(sessionId: string): string | undefined {
  if (!checkDocker()) return undefined;
  const name = `nanocode-${sessionId.replace(/[/:]/g, "_")}`;
  const netFlag = sandboxNetworkFlag(sessionId);
  try {
    execSync(`docker run -d --name ${name} --rm --memory 512m --cpus 1 ${netFlag} -v "${process.cwd()}:/workspace" -w /workspace ubuntu:22.04 sleep infinity`, { stdio: "ignore", timeout: 30000 });
    return name;
  } catch { return undefined; }
}

function destroySandbox(containerId: string) {
  try { execSync(`docker rm -f ${containerId}`, { stdio: "ignore", timeout: 10000 }); } catch {}
}

function execInSandbox(containerId: string, cmd: string): string {
  return execSync(`docker exec ${containerId} bash -c ${JSON.stringify(cmd)}`, { encoding: "utf-8", timeout: 30000 }).trim();
}

// --- Gateway ---
const gatewayClients = new Set<any>();
const authenticatedClients = new Set<any>();
const seenIdempotencyKeys = new Set<string>();
const devicePairings = new Map<string, string>(); // deviceId -> publicKey
let gatewayServer: any = null;

// Remote access configuration
const REMOTE_MODE = process.env.NANOCODE_REMOTE_MODE ?? "local"; // local | tailscale-serve | tailscale-funnel
const GATEWAY_PASSWORD = process.env.NANOCODE_GATEWAY_PASSWORD ?? "";

function isLocalConnection(ws: any): boolean {
  const addr = ws.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "localhost";
}

function isAuthenticated(ws: any): boolean {
  if (isLocalConnection(ws)) return true;
  return authenticatedClients.has(ws);
}

// Device pairing via challenge-response
function generateChallenge(): { challenge: string; nonce: string } {
  const nonce = randomUUID();
  return { challenge: Buffer.from(nonce).toString("base64"), nonce };
}

function verifyPairing(deviceId: string, challenge: string, signature: string): boolean {
  const pubKey = devicePairings.get(deviceId);
  if (!pubKey) return false;
  try {
    const verify = require("node:crypto").createVerify("SHA256");
    verify.update(challenge);
    return verify.verify(pubKey, Buffer.from(signature, "base64"));
  } catch { return false; }
}

async function loadDevicePairings() {
  try {
    const pairings = JSON.parse(await readFile(`${NANOCODE_DIR}/device_pairings.json`, "utf-8"));
    for (const [id, key] of Object.entries(pairings)) devicePairings.set(id, key as string);
  } catch {}
}

function setupRemoteAccess() {
  if (REMOTE_MODE === "tailscale-serve") {
    try { execSync(`tailscale serve --bg https+insecure://localhost:${GATEWAY_PORT}`, { stdio: "ignore", timeout: 10000 }); } catch {}
  } else if (REMOTE_MODE === "tailscale-funnel") {
    try { execSync(`tailscale funnel --bg https+insecure://localhost:${GATEWAY_PORT}`, { stdio: "ignore", timeout: 10000 }); } catch {}
  }
}

function startGateway() {
  try {
    gatewayServer = Bun.serve({
      port: GATEWAY_PORT,
      hostname: GATEWAY_HOST,
      fetch(req: Request, server: any) {
        if (server.upgrade(req)) return undefined;
        return new Response(JSON.stringify({ status: "nanocode gateway", sessions: sessions.size }), { headers: { "Content-Type": "application/json" } });
      },
      websocket: {
        open(ws: any) { gatewayClients.add(ws); },
        close(ws: any) { gatewayClients.delete(ws); authenticatedClients.delete(ws); },
        async message(ws: any, raw: any) {
          try {
            const msg = validateGatewayMessage(String(raw));
            // Auth messages don't require prior authentication
            if (msg.type === "auth") {
              if (msg.password && msg.password === GATEWAY_PASSWORD) {
                authenticatedClients.add(ws);
                ws.send(JSON.stringify({ type: "auth_ok" }));
              } else if ((msg as any).challenge && (msg as any).signature && (msg as any).deviceId) {
                if (verifyPairing((msg as any).deviceId, (msg as any).challenge, (msg as any).signature)) {
                  authenticatedClients.add(ws);
                  ws.send(JSON.stringify({ type: "auth_ok" }));
                } else {
                  ws.send(JSON.stringify({ type: "error", error: "Authentication failed" }));
                }
              } else {
                const { challenge, nonce } = generateChallenge();
                ws.send(JSON.stringify({ type: "auth_challenge", challenge, nonce }));
              }
              return;
            }
            if (!isAuthenticated(ws)) { ws.send(JSON.stringify({ type: "error", error: "Not authenticated" })); return; }
            await handleGatewayMessage(ws, msg);
          } catch (e) {
            ws.send(JSON.stringify({ type: "error", error: String(e) }));
          }
        },
      },
    });
  } catch {}
}

async function handleGatewayMessage(ws: any, msg: GatewayMessage) {
  // Idempotency check
  if (msg.idempotencyKey) {
    if (seenIdempotencyKeys.has(msg.idempotencyKey)) return;
    seenIdempotencyKeys.add(msg.idempotencyKey);
    if (seenIdempotencyKeys.size > 10000) seenIdempotencyKeys.clear(); // prevent unbounded growth
  }

  if (msg.type === "heartbeat") {
    ws.send(JSON.stringify({ type: "heartbeat_ack" }));
    return;
  }

  if (msg.type === "message" && msg.source && msg.text) {
    const sessionType: SessionType = msg.source.channel.startsWith("D") ? "dm" : "group";
    const sessionId = `${sessionType}:${msg.source.platform}:${msg.source.channel}:${msg.source.user}`;
    const session = getOrCreateSession(sessionId, sessionType);

    // Create sandbox for non-main sessions if Docker available
    if (session.type !== "main" && !session.containerId && checkDocker()) {
      session.containerId = createSandbox(sessionId);
    }

    // Wrap with source metadata for prompt injection defense
    const wrappedContent = `<source platform="${msg.source.platform}" user="${msg.source.user}" channel="${msg.source.channel}">\n${msg.text}\n</source>`;
    session.messages.push({ role: "user", content: wrappedContent });

    const sink = wsSink(ws, sessionId);
    const systemPrompt = await loadSystemPrompt(session);
    await runAgentLoop(session.messages, systemPrompt, { session, sink });
    ws.send(JSON.stringify({ type: "message_end", sessionId }));
  }
}

function gatewayBroadcast(event: object) {
  const data = JSON.stringify(event);
  for (const ws of gatewayClients) { try { ws.send(data); } catch {} }
}

// --- Slack Adapter ---
let slackSocket: WebSocket | null = null;
let slackBotUserId = "";

// Allowlist: load from config or env
function loadSlackAllowlist(): { users: Set<string>; channels: Set<string> } {
  const users = new Set<string>();
  const channels = new Set<string>();
  try {
    const config = JSON.parse(require("fs").readFileSync(`${NANOCODE_DIR}/slack_allowlist.json`, "utf-8"));
    for (const u of config.users ?? []) users.add(u);
    for (const c of config.channels ?? []) channels.add(c);
  } catch {}
  const envUsers = process.env.NANOCODE_SLACK_ALLOW_USERS;
  const envChannels = process.env.NANOCODE_SLACK_ALLOW_CHANNELS;
  if (envUsers) for (const u of envUsers.split(",")) users.add(u.trim());
  if (envChannels) for (const c of envChannels.split(",")) channels.add(c.trim());
  return { users, channels };
}

const slackAllowlist = loadSlackAllowlist();

function isSlackAllowed(userId: string, channelId: string): boolean {
  if (slackAllowlist.users.size === 0 && slackAllowlist.channels.size === 0) return true; // no allowlist = allow all
  if (slackAllowlist.users.has(userId)) return true;
  if (slackAllowlist.channels.has(channelId)) return true;
  return false;
}

// Rate limiting
const slackRateLimits = new Map<string, number[]>(); // userId -> timestamps
const SLACK_RATE_LIMIT_WINDOW = 60000; // 1 minute
const SLACK_RATE_LIMIT_MAX = 10; // max messages per window

function checkSlackRateLimit(userId: string): boolean {
  const now = Date.now();
  const timestamps = slackRateLimits.get(userId) ?? [];
  const recent = timestamps.filter((t) => now - t < SLACK_RATE_LIMIT_WINDOW);
  if (recent.length >= SLACK_RATE_LIMIT_MAX) return false;
  recent.push(now);
  slackRateLimits.set(userId, recent);
  return true;
}

async function slackApi(token: string, method: string, body: object = {}): Promise<any> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json() as any;
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
  return data;
}

async function connectSlack() {
  const appToken = process.env.NANOCODE_SLACK_APP_TOKEN;
  const botToken = process.env.NANOCODE_SLACK_BOT_TOKEN;
  if (!appToken || !botToken) return;

  try {
    const auth = await slackApi(botToken, "auth.test");
    slackBotUserId = auth.user_id;
    // Register slash commands if manifest token available
    const manifestToken = process.env.NANOCODE_SLACK_CONFIG_TOKEN;
    if (manifestToken) {
      try {
        const appId = auth.app_id ?? process.env.NANOCODE_SLACK_APP_ID;
        if (appId) {
          await slackApi(manifestToken, "apps.manifest.update", {
            app_id: appId,
            manifest: { slash_commands: [{ command: "/nanocode", description: "Talk to nanocode agent", usage_hint: "[your message]" }] },
          });
        }
      } catch {}
    }
    const conn = await slackApi(appToken, "apps.connections.open");
    openSlackSocket(conn.url, botToken);
    console.log(`${ANSI.dim}⏺ Slack connected as ${auth.user}${ANSI.reset}`);
  } catch (e) {
    console.log(`${ANSI.dim}Slack connection failed: ${e}${ANSI.reset}`);
  }
}

function openSlackSocket(url: string, botToken: string) {
  slackSocket = new WebSocket(url);
  slackSocket.onmessage = async (evt: MessageEvent) => {
    try {
      const payload = JSON.parse(String(evt.data));
      // Acknowledge envelope
      if (payload.envelope_id) slackSocket?.send(JSON.stringify({ envelope_id: payload.envelope_id }));
      if (payload.type === "events_api") {
        await handleSlackEvent(payload.payload.event, botToken);
      }
    } catch {}
  };
  slackSocket.onclose = () => { setTimeout(() => connectSlack(), 5000); };
}

async function handleSlackEvent(event: any, botToken: string) {
  if (event.bot_id || event.user === slackBotUserId) return;
  const isDM = event.channel_type === "im";
  const isMention = event.type === "app_mention";
  const isSlashCommand = event.type === "slash_command";
  if (!isDM && !isMention && !isSlashCommand) return;

  // Allowlist check
  if (!isSlackAllowed(event.user, event.channel)) return;

  // Rate limiting
  if (!checkSlackRateLimit(event.user)) {
    try {
      await slackApi(botToken, "chat.postMessage", { channel: event.channel, text: "Rate limit exceeded. Please wait a moment.", thread_ts: event.thread_ts || event.ts });
    } catch {}
    return;
  }

  let text = isSlashCommand ? (event.command + " " + (event.text ?? "")).trim() : (event.text ?? "").replace(/<@[^>]+>/g, "").trim();
  if (!text) return;

  // Handle file/media attachments
  const mediaDescriptions: string[] = [];
  if (event.files?.length) {
    for (const file of event.files) {
      try {
        const fileRes = await fetch(file.url_private, { headers: { Authorization: `Bearer ${botToken}` } });
        if (fileRes.ok) {
          const content = file.mimetype?.startsWith("text/") ? await fileRes.text() : null;
          mediaDescriptions.push(content
            ? `[File: ${file.name} (${file.mimetype})]\n${content.slice(0, 5000)}`
            : `[File: ${file.name} (${file.mimetype}, ${file.size} bytes) - binary file, content not shown]`
          );
        }
      } catch {}
    }
    if (mediaDescriptions.length) text += "\n\n" + mediaDescriptions.join("\n");
  }

  const sessionType: SessionType = isDM ? "dm" : "group";
  const sessionId = `${sessionType}:slack:${event.channel}:${event.user}`;
  const session = getOrCreateSession(sessionId, sessionType);

  if (session.type !== "main" && !session.containerId && checkDocker()) {
    session.containerId = createSandbox(sessionId);
  }

  session.messages.push({ role: "user", content: text });
  const systemPrompt = await loadSystemPrompt(session);

  let responseText = "";
  const threadTs = event.thread_ts || event.ts;
  const sink: OutputSink = { write: (t) => { responseText += t; }, log: () => {} };

  await runAgentLoop(session.messages, systemPrompt, { session, sink });

  // Post response, respecting Slack's 4000 char limit
  if (responseText.trim()) {
    const chunks = [];
    let remaining = responseText.trim();
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, 3900));
      remaining = remaining.slice(3900);
    }
    for (const chunk of chunks) {
      try { await slackApi(botToken, "chat.postMessage", { channel: event.channel, text: chunk, thread_ts: threadTs }); } catch {}
    }
  }
}

// --- Discord Adapter (second adapter, validates pattern generalizes) ---
let discordWs: WebSocket | null = null;
let discordBotUserId = "";

async function connectDiscord() {
  const botToken = process.env.NANOCODE_DISCORD_BOT_TOKEN;
  if (!botToken) return;

  try {
    // Get gateway URL
    const gwRes = await fetch("https://discord.com/api/v10/gateway/bot", { headers: { Authorization: `Bot ${botToken}` } });
    if (!gwRes.ok) throw new Error(`Discord gateway: ${gwRes.status}`);
    const gwData = await gwRes.json() as any;

    // Get bot user info
    const meRes = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bot ${botToken}` } });
    if (meRes.ok) { const me = await meRes.json() as any; discordBotUserId = me.id; }

    openDiscordSocket(gwData.url + "?v=10&encoding=json", botToken);
    console.log(`${ANSI.dim}⏺ Discord connected${ANSI.reset}`);
  } catch (e) {
    console.log(`${ANSI.dim}Discord connection failed: ${e}${ANSI.reset}`);
  }
}

function openDiscordSocket(url: string, botToken: string) {
  discordWs = new WebSocket(url);
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let seq: number | null = null;

  discordWs.onmessage = async (evt: MessageEvent) => {
    try {
      const payload = JSON.parse(String(evt.data));
      if (payload.s) seq = payload.s;

      if (payload.op === 10) {
        // Hello - start heartbeat and identify
        heartbeatInterval = setInterval(() => { discordWs?.send(JSON.stringify({ op: 1, d: seq })); }, payload.d.heartbeat_interval);
        discordWs?.send(JSON.stringify({ op: 2, d: { token: botToken, intents: 33280, properties: { os: "linux", browser: "nanocode", device: "nanocode" } } }));
      } else if (payload.op === 11) {
        // Heartbeat ACK - no action needed
      } else if (payload.t === "MESSAGE_CREATE") {
        await handleDiscordMessage(payload.d, botToken);
      }
    } catch {}
  };

  discordWs.onclose = () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    setTimeout(() => connectDiscord(), 5000);
  };
}

async function handleDiscordMessage(msg: any, botToken: string) {
  if (msg.author?.bot || msg.author?.id === discordBotUserId) return;

  const isDM = !msg.guild_id;
  const isMention = msg.mentions?.some((m: any) => m.id === discordBotUserId);
  if (!isDM && !isMention) return;

  const text = (msg.content ?? "").replace(/<@!?\d+>/g, "").trim();
  if (!text) return;

  const sessionType: SessionType = isDM ? "dm" : "group";
  const sessionId = `${sessionType}:discord:${msg.channel_id}:${msg.author.id}`;
  const session = getOrCreateSession(sessionId, sessionType);

  if (session.type !== "main" && !session.containerId && checkDocker()) {
    session.containerId = createSandbox(sessionId);
  }

  session.messages.push({ role: "user", content: text });
  const systemPrompt = await loadSystemPrompt(session);

  let responseText = "";
  const sink: OutputSink = { write: (t) => { responseText += t; }, log: () => {} };
  await runAgentLoop(session.messages, systemPrompt, { session, sink });

  if (responseText.trim()) {
    const chunks = [];
    let remaining = responseText.trim();
    while (remaining.length > 0) { chunks.push(remaining.slice(0, 1900)); remaining = remaining.slice(1900); }
    for (const chunk of chunks) {
      try {
        await fetch(`https://discord.com/api/v10/channels/${msg.channel_id}/messages`, {
          method: "POST",
          headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ content: chunk, message_reference: msg.guild_id ? { message_id: msg.id } : undefined }),
        });
      } catch {}
    }
  }
}

// --- Tools ---
const TOOLS: Record<string, Tool> = {
  read: {
    desc: "Read file with line numbers", params: ["path"], summarizable: true,
    fn: async (args, session) => {
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
        .slice(0, 10).map((m: RegExpExecArray) => `${m[2].replace(/<[^>]+>/g, "")} - ${m[1]}`);
      return results.join("\n") || "no results";
    },
  },
  webfetch: {
    desc: "Fetch a URL and return its content as markdown", params: ["url"],
    fn: async (args, session) => {
      const response = await fetch(args.url);
      if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
      const html = await response.text();
      let md = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi, (_: string, level: string, text: string) => `${"#".repeat(Number(level))} ${text.replace(/<[^>]+>/g, "")}\n`)
        .replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
        .replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi, "**$2**").replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gi, "*$2*")
        .replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`").replace(/<pre[^>]*>(.*?)<\/pre>/gis, "```\n$1\n```\n")
        .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n").replace(/<br\s*\/?>/gi, "\n").replace(/<p[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
        .replace(/\n{3,}/g, "\n\n").trim();
      if (md.length > 10000 && session) {
        const summary = await quickLLM(session.provider, "Summarize this web page content. Preserve key information, code examples, and important details. Output only the summary in markdown.", md.slice(0, 50000));
        if (summary) return summary;
      }
      return md;
    },
  },
  bash: {
    desc: "Run shell command", params: ["cmd"], summarizable: true,
    fn: (args, session) => {
      if (session?.containerId) return execInSandbox(session.containerId, args.cmd);
      return execSync(args.cmd, { encoding: "utf-8", timeout: 30000 }).trim();
    },
  },
  subagent: {
    desc: "Delegate a research task to a sub-agent with its own context window. Use for multi-step investigations.",
    params: ["task"],
    fn: async (args, session) => {
      const subSession = createSession(`sub_${randomUUID().slice(0, 8)}`, session?.type ?? "main", {
        provider: session?.provider, model: session?.model, cwd: session?.cwd,
      });
      subSession.messages.push({ role: "user", content: args.task });
      const systemPrompt = `Concise coding assistant. cwd: ${subSession.cwd}. You are a sub-agent. Use tools to investigate, then provide a clear final answer.`;
      const result = await runAgentLoop(subSession.messages, systemPrompt, { session: subSession, sink: nullSink, compact: false, summarizeTools: false });
      sessions.delete(subSession.id);
      return result;
    },
  },
  // Cross-session tools (main only)
  sessions_list: {
    desc: "List all active sessions with their types and message counts", params: [], mainOnly: true,
    fn: () => {
      const list = [...sessions.entries()].map(([id, s]) => `${id} (${s.type}, ${s.messages.length} msgs, ${s.running ? "running" : "idle"})`);
      return list.join("\n") || "No active sessions";
    },
  },
  sessions_send: {
    desc: "Send a message to another session by ID", params: ["sessionId", "message"], mainOnly: true,
    fn: async (args) => {
      const target = sessions.get(args.sessionId);
      if (!target) return `Session not found: ${args.sessionId}`;
      target.messages.push({ role: "user", content: args.message });
      // Don't await - let it run asynchronously
      const systemPrompt = await loadSystemPrompt(target);
      runAgentLoop(target.messages, systemPrompt, { session: target, sink: nullSink });
      return `Message sent to ${args.sessionId}`;
    },
  },
  sessions_history: {
    desc: "Read another session's recent message history", params: ["sessionId"], mainOnly: true,
    fn: (args) => {
      const target = sessions.get(args.sessionId);
      if (!target) return `Session not found: ${args.sessionId}`;
      return target.messages.slice(-20).map((m: any) => `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 200) : "..."}`).join("\n");
    },
  },
  sessions_spawn: {
    desc: "Create a new session with an initial task", params: ["sessionId", "task"], mainOnly: true,
    fn: async (args, parentSession) => {
      const session = createSession(args.sessionId, (args.type as SessionType) ?? "main", {
        provider: parentSession?.provider, model: parentSession?.model, cwd: parentSession?.cwd,
      });
      session.messages.push({ role: "user", content: args.task });
      const systemPrompt = await loadSystemPrompt(session);
      runAgentLoop(session.messages, systemPrompt, { session, sink: nullSink });
      return `Session ${args.sessionId} spawned with task`;
    },
  },
  // Memory tools
  memory_search: {
    desc: "Search long-term memory for relevant information", params: ["query"],
    fn: (args) => {
      const results = memorySearch(args.query, 10);
      return results.length ? results.join("\n---\n") : "No memories found";
    },
  },
  memory_write: {
    desc: "Save information to long-term memory", params: ["content", "tags"],
    fn: (args) => { memorySave(args.content, args.tags ?? "", "agent"); return "Memory saved"; },
  },
};

// --- Agent Loop ---
interface AgentOptions { compact?: boolean; summarizeTools?: boolean; session?: SessionState; sink?: OutputSink }

async function runAgentLoop(messages: any[], systemPrompt: string, opts: AgentOptions = {}): Promise<string> {
  const { compact = true, summarizeTools = true } = opts;
  const session = opts.session ?? getOrCreateSession("main", "main");
  const sink = opts.sink ?? stdoutSink;
  let lastText = "";

  if (session.running) {
    session.queue.push(messages[messages.length - 1]?.content ?? "");
    return "Session busy, message queued";
  }
  session.running = true;
  await fireHook("agent_start", { session });

  try {
    const filteredTools = filterToolsForSession(TOOLS, session);

    while (true) {
      await fireHook("turn_start", { session, messages });

      if (compact) {
        const tokens = await countTokens(messages, systemPrompt, session);
        if (tokens > COMPACT_THRESHOLD) await compactMessages(messages, session);
      }

      const response = await streamLLM(messages, systemPrompt, filteredTools, session, sink);
      messages.push({ role: "assistant", content: response.content });
      lastText = response.content.find((b: any) => b.type === "text")?.text ?? lastText;

      await fireHook("turn_end", { session, response });
      if (response.stop_reason !== "tool_use") break;

      const toolResults = await Promise.all(
        response.content.filter((b: any) => b.type === "tool_use").map(async (block: any) => {
          const preview = String(Object.values(block.input)[0] ?? "").slice(0, 50);
          sink.log(`\n${ANSI.green}⏺ ${block.name}${ANSI.reset}(${ANSI.dim}${preview}${ANSI.reset})`);
          await fireHook("tool_call", { session, tool: block.name, input: block.input });
          try {
            let result = await (filteredTools[block.name]?.fn(block.input, session) ?? `unknown tool: ${block.name}`);
            if (summarizeTools && filteredTools[block.name]?.summarizable) result = await summarizeToolResult(block.name, result, session);
            sink.log(`  ${ANSI.dim}⎿  ${result.split("\n")[0].slice(0, 60)}${result.includes("\n") ? ` +${result.split("\n").length - 1} lines` : ""}${ANSI.reset}`);
            await fireHook("tool_result", { session, tool: block.name, result });
            // Structured wrapping to isolate tool output from instructions
            const wrapped = `<tool_result name="${block.name}">\n${result}\n</tool_result>`;
            return { type: "tool_result", tool_use_id: block.id, content: wrapped };
          } catch (err: any) {
            await fireHook("tool_result", { session, tool: block.name, error: String(err) });
            return { type: "tool_result", tool_use_id: block.id, content: String(err), is_error: true };
          }
        }),
      );
      messages.push({ role: "user", content: toolResults });
    }
  } finally {
    session.running = false;
    await fireHook("agent_end", { session, result: lastText });
    // Process queued messages
    if (session.queue.length > 0) {
      const next = session.queue.shift()!;
      messages.push({ role: "user", content: next });
      return runAgentLoop(messages, systemPrompt, opts);
    }
  }

  return lastText;
}

// --- REPL Commands ---
const COMMANDS = new Map<string, (args: string, session: SessionState, sink: OutputSink) => Promise<boolean | void>>();

COMMANDS.set("/q", async () => true); // signal exit
COMMANDS.set("exit", async () => true);
COMMANDS.set("/c", async (_, session, sink) => { session.messages.length = 0; sink.log(`${ANSI.green}⏺ Cleared${ANSI.reset}`); });
COMMANDS.set("/cost", async (_, session, sink) => {
  sink.log(`${ANSI.dim}Tokens: ${session.usage.inputTokens.toLocaleString()} in / ${session.usage.outputTokens.toLocaleString()} out | Cost: $${session.usage.usd.toFixed(4)}${ANSI.reset}`);
});
COMMANDS.set("/sessions", async (_, __, sink) => {
  const active = [...sessions.entries()].map(([id, s]) => `  ${id} (${s.type}, ${s.messages.length} msgs)`).join("\n");
  const saved = await listSessionNames();
  sink.log(`${ANSI.bold}Active:${ANSI.reset}\n${active || "  none"}\n${ANSI.bold}Saved:${ANSI.reset}\n${saved.length ? saved.map((n: string) => `  ${n}`).join("\n") : "  none"}`);
});
COMMANDS.set("/save", async (args, session, sink) => {
  const name = args.trim();
  if (name) { await saveSession(name, session.messages); sink.log(`${ANSI.green}⏺ Saved: ${name}${ANSI.reset}`); }
});
COMMANDS.set("/load", async (args, session, sink) => {
  const name = args.trim();
  try {
    const msgs = await getSessionMessages(name);
    session.messages.length = 0; session.messages.push(...msgs);
    sink.log(`${ANSI.green}⏺ Loaded: ${name} (${msgs.length} messages)${ANSI.reset}`);
  } catch { sink.log(`${ANSI.red}Session not found: ${name}${ANSI.reset}`); }
});
COMMANDS.set("/model", async (args, session, sink) => {
  const arg = args.trim();
  const [p, m] = arg.includes(":") ? arg.split(":") : [null, arg];
  if (p && PROVIDERS[p]) { session.provider = PROVIDERS[p]; session.model = m || session.provider.defaultModel; }
  else if (p) { sink.log(`${ANSI.red}Unknown provider: ${p}. Available: ${Object.keys(PROVIDERS).join(", ")}${ANSI.reset}`); return; }
  else { session.model = m; }
  await fireHook("model_select", { session, model: session.model });
  sink.log(`${ANSI.green}⏺ Model: ${session.model}${ANSI.reset}`);
});
COMMANDS.set("/tree", async (_, session, sink) => {
  const entries = await loadSessionTree(session.id);
  sink.log(entries.length ? sessionTree(entries) : "No session history on disk. Use /save first.");
});
COMMANDS.set("/fork", async (args, session, sink) => {
  const forkId = await forkSession(session.id, args.trim() || undefined);
  sink.log(`${ANSI.green}⏺ Forked to: ${forkId}${ANSI.reset}`);
});
COMMANDS.set("/goto", async (args, session, sink) => {
  const idx = parseInt(args.trim(), 10);
  if (isNaN(idx) || idx < 1) { sink.log("Usage: /goto <entry number> - navigate to a point in session history"); return; }
  const entries = await loadSessionTree(session.id);
  if (!entries.length) { sink.log("No session history on disk. Use /save first."); return; }
  const messageEntries = entries.filter((e) => e.type === "message" && e.role && e.content);
  if (idx > messageEntries.length) { sink.log(`Only ${messageEntries.length} entries in history`); return; }
  const sliced = messageEntries.slice(0, idx);
  session.messages.length = 0;
  session.messages.push(...sliced.map((e) => ({ role: e.role, content: e.content })));
  sink.log(`${ANSI.green}⏺ Navigated to entry ${idx} (${sliced.length} messages loaded)${ANSI.reset}`);
});
COMMANDS.set("/memory", async (args, _, sink) => {
  const query = args.trim();
  if (!query) { sink.log("Usage: /memory <search query>"); return; }
  const results = memorySearch(query);
  sink.log(results.length ? results.join("\n---\n") : "No memories found");
});

// --- Main ---
async function main() {
  // Initialize subsystems
  await mkdir(NANOCODE_DIR, { recursive: true });
  await initMemory();
  await loadDevicePairings();
  // Parse extension flags from argv
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--(\w+)=(.+)$/);
    if (match && extFlags.has(match[1])) extFlags.get(match[1])!.value = match[2];
  }
  const mainSession = createSession("main", "main", { cwd: process.cwd() });
  await loadExtensions(mainSession);
  startGateway();
  setupRemoteAccess();
  connectSlack(); // non-blocking, no await
  connectDiscord(); // non-blocking, no await

  const systemPrompt = await loadSystemPrompt(mainSession);

  console.log(`
${ANSI.bold}${ANSI.cyan}
 ███╗   ██╗ █████╗ ███╗   ██╗ ██████╗  ██████╗ ██████╗ ██████╗ ███████╗
 ████╗  ██║██╔══██╗████╗  ██║██╔═══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝
 ██╔██╗ ██║███████║██╔██╗ ██║██║   ██║██║     ██║   ██║██║  ██║█████╗
 ██║╚██╗██║██╔══██║██║╚██╗██║██║   ██║██║     ██║   ██║██║  ██║██╔══╝
 ██║ ╚████║██║  ██║██║ ╚████║╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗
 ╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
${ANSI.reset}
${ANSI.dim}nanocode${ANSI.reset} | ${ANSI.dim}${mainSession.model}${ANSI.reset} | ${ANSI.dim}${process.cwd()}${ANSI.reset}
${gatewayServer ? `${ANSI.dim}gateway: ${GATEWAY_HOST}:${GATEWAY_PORT}${ANSI.reset}` : ""}
${slackBotUserId ? `${ANSI.dim}slack: connected${ANSI.reset}` : ""}
${discordBotUserId ? `${ANSI.dim}discord: connected${ANSI.reset}` : ""}
`);

  const separator = () => console.log(`${ANSI.dim}${"─".repeat(80)}${ANSI.reset}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    separator();
    const input = await new Promise<string>((resolve) => {
      rl.question(`${ANSI.bold}${ANSI.blue}❯${ANSI.reset} `, (answer: string) => resolve(answer.trim()));
    });
    separator();
    if (!input) continue;

    // Command dispatch
    const spaceIdx = input.indexOf(" ");
    const cmdName = spaceIdx > 0 ? input.slice(0, spaceIdx) : input;
    const cmdArgs = spaceIdx > 0 ? input.slice(spaceIdx + 1) : "";

    const handler = COMMANDS.get(cmdName) ?? extCommands.get(cmdName);
    if (handler) {
      const shouldExit = await handler(cmdArgs, mainSession, stdoutSink);
      if (shouldExit === true) break;
      continue;
    }

    mainSession.messages.push({ role: "user", content: input });
    const currentPrompt = await loadSystemPrompt(mainSession);
    await runAgentLoop(mainSession.messages, currentPrompt, { session: mainSession, sink: stdoutSink });
    console.log();
  }

  // Cleanup
  await fireHook("session_shutdown", { session: mainSession });
  for (const [_, s] of sessions) { if (s.containerId) destroySandbox(s.containerId); }
  if (slackSocket) slackSocket.close();
  if (discordWs) discordWs.close();
  rl.close();
}

main().catch((e) => { console.error(`${ANSI.red}Fatal: ${e}${ANSI.reset}`); process.exit(1); });
