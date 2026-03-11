#!/usr/bin/env bun
/** nanocode - minimal deep coding agent */
import { readFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import * as readline from "node:readline";

// --- Config ---
const MODEL = "claude-sonnet-4-5";
const SUMMARIZE_MODEL = "claude-haiku-4-5-20251001";
const COMPACT_THRESHOLD = 150000;
const CONTEXT_LIMIT = 200000;
const TOOL_SUMMARIZE_THRESHOLD = 200; // lines

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};

// --- API layer ---
type Tool = { desc: string; params: string[]; summarizable?: boolean; fn: (args: any) => Promise<string> | string };

async function apiFetch(path: string, body: object) {
  return fetch(`https://api.anthropic.com/v1/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
}

function buildToolSchema(tools: Record<string, Tool>) {
  return Object.entries(tools).map(([name, { desc, params }]) => ({
    name,
    description: desc,
    input_schema: {
      type: "object",
      properties: Object.fromEntries(params.map((p) => [p, { type: "string" }])),
      required: params,
    },
  }));
}

async function countTokens(messages: any[], systemPrompt: string, tools: Record<string, Tool>) {
  const response = await apiFetch("messages/count_tokens", { model: MODEL, system: systemPrompt, messages, tools: buildToolSchema(tools) });
  if (!response.ok) return CONTEXT_LIMIT;
  return (await response.json() as any).input_tokens as number;
}

async function streamAPI(messages: any[], systemPrompt: string, tools: Record<string, Tool>) {
  const response = await apiFetch("messages", { model: MODEL, max_tokens: 8192, system: systemPrompt, messages, tools: buildToolSchema(tools), stream: true });
  if (!response.ok) throw new Error(`API error: ${response.status}`);

  const content: any[] = [];
  let stopReason = "";
  let buffer = "";
  let currentBlock: any = null;
  let toolJsonBuf = "";
  let textStarted = false;

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

      if (data.type === "content_block_start") {
        currentBlock = data.content_block;
        if (currentBlock.type === "text") {
          textStarted = false;
        } else if (currentBlock.type === "tool_use") {
          toolJsonBuf = "";
        }
      } else if (data.type === "content_block_delta") {
        if (data.delta.type === "text_delta") {
          if (!textStarted) { process.stdout.write(`\n${ANSI.cyan}⏺${ANSI.reset} `); textStarted = true; }
          process.stdout.write(data.delta.text);
          currentBlock.text = (currentBlock.text || "") + data.delta.text;
        } else if (data.delta.type === "input_json_delta") {
          toolJsonBuf += data.delta.partial_json;
        }
      } else if (data.type === "content_block_stop") {
        if (currentBlock.type === "tool_use") {
          currentBlock.input = toolJsonBuf ? JSON.parse(toolJsonBuf) : {};
        }
        content.push(currentBlock);
        currentBlock = null;
      } else if (data.type === "message_delta") {
        stopReason = data.delta.stop_reason ?? stopReason;
      }
    }
  }

  return { content, stop_reason: stopReason };
}

// --- Context management ---
async function compactMessages(messages: any[]) {
  const splitAt = Math.floor(messages.length * 0.8);
  const oldMessages = messages.slice(0, splitAt);
  const recentMessages = messages.slice(splitAt);

  const response = await apiFetch("messages", {
    model: SUMMARIZE_MODEL,
    max_tokens: 2048,
    system: "Summarize this conversation concisely. Preserve: key decisions, files modified, current task state, and any unresolved issues. Output only the summary.",
    messages: [...oldMessages, { role: "user", content: "Summarize the conversation so far." }],
  });
  if (!response.ok) return;

  const summary = (await response.json() as any).content?.[0]?.text ?? "";
  if (!summary) return;

  messages.length = 0;
  messages.push({ role: "user", content: `[Conversation summary]\n${summary}` });
  messages.push({ role: "assistant", content: "Understood. I have the context from our previous conversation. How can I continue helping?" });
  messages.push(...recentMessages);
  console.log(`\n${ANSI.dim}⏺ Context compacted${ANSI.reset}`);
}

async function summarizeToolResult(toolName: string, result: string): Promise<string> {
  if (result.split("\n").length < TOOL_SUMMARIZE_THRESHOLD) return result;

  const response = await apiFetch("messages", {
    model: SUMMARIZE_MODEL,
    max_tokens: 1024,
    system: `Summarize this ${toolName} tool output concisely. Preserve key details: file structure, important line numbers, function names, error messages, and anything a coding assistant would need. Output only the summary.`,
    messages: [{ role: "user", content: result }],
  });
  if (!response.ok) return result;

  return (await response.json() as any).content?.[0]?.text ?? result;
}

// --- Tools ---
const TOOLS: Record<string, Tool> = {
  read: {
    desc: "Read file with line numbers",
    params: ["path"],
    summarizable: true,
    fn: async (args) => {
      const lines = (await readFile(args.path, "utf-8")).split("\n");
      const start = args.offset ?? 0;
      const end = start + (args.limit ?? lines.length);
      return lines.slice(start, end).map((line, i) => `${String(start + i + 1).padStart(4)}| ${line}`).join("\n");
    },
  },
  write: {
    desc: "Write content to file",
    params: ["path", "content"],
    fn: async (args) => {
      await writeFile(args.path, args.content, "utf-8");
      return "ok";
    },
  },
  edit: {
    desc: "Replace old with new in file",
    params: ["path", "old", "new"],
    fn: async (args) => {
      const content = await readFile(args.path, "utf-8");
      const result = args.all ? content.split(args.old).join(args.new) : content.replace(args.old, args.new);
      await writeFile(args.path, result, "utf-8");
      return "ok";
    },
  },
  glob: {
    desc: "Find files by pattern",
    params: ["pat"],
    fn: async (args) => (await Array.fromAsync(new Bun.Glob(`${args.path ?? "."}/${args.pat}`).scan())).join("\n") || "none",
  },
  grep: {
    desc: "Search files for regex",
    params: ["pat"],
    summarizable: true,
    fn: async (args) => {
      const pattern = new RegExp(args.pat);
      const hits: string[] = [];
      for await (const file of new Bun.Glob(`${args.path ?? "."}/**`).scan()) {
        if (file.includes("node_modules")) continue;
        const content = await readFile(file, "utf-8");
        content.split("\n").forEach((line, i) => {
          if (pattern.test(line)) hits.push(`${file}:${i + 1}:${line.trim()}`);
        });
      }
      return hits.slice(0, 50).join("\n") || "none";
    },
  },
  bash: {
    desc: "Run shell command",
    params: ["cmd"],
    summarizable: true,
    fn: (args) => execSync(args.cmd, { encoding: "utf-8", timeout: 30000 }).trim(),
  },
  subagent: {
    desc: "Delegate a research task to a sub-agent with its own context window. Use for multi-step investigations that require reading many files or searching broadly.",
    params: ["task"],
    fn: async (args) => {
      const result = await runAgentLoop(
        [{ role: "user", content: args.task }],
        `Concise coding assistant. cwd: ${process.cwd()}. You are a sub-agent handling a research task. Use tools to investigate, then provide a clear final answer.`,
        { compact: false, summarizeTools: false },
      );
      return result;
    },
  },
};

// --- Agent loop ---
interface AgentOptions { compact?: boolean; summarizeTools?: boolean }

async function runAgentLoop(messages: any[], systemPrompt: string, opts: AgentOptions = {}): Promise<string> {
  const { compact = true, summarizeTools = true } = opts;
  let lastText = "";

  while (true) {
    if (compact) {
      const tokens = await countTokens(messages, systemPrompt, TOOLS);
      if (tokens > COMPACT_THRESHOLD) await compactMessages(messages);
    }

    const response = await streamAPI(messages, systemPrompt, TOOLS);
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

// --- Main ---
async function main() {
  console.log(`
${ANSI.bold}${ANSI.cyan}
 ███╗   ██╗ █████╗ ███╗   ██╗ ██████╗  ██████╗ ██████╗ ██████╗ ███████╗
 ████╗  ██║██╔══██╗████╗  ██║██╔═══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝
 ██╔██╗ ██║███████║██╔██╗ ██║██║   ██║██║     ██║   ██║██║  ██║█████╗
 ██║╚██╗██║██╔══██║██║╚██╗██║██║   ██║██║     ██║   ██║██║  ██║██╔══╝
 ██║ ╚████║██║  ██║██║ ╚████║╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗
 ╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
${ANSI.reset}
${ANSI.dim}nanocode${ANSI.reset} | ${ANSI.dim}${MODEL}${ANSI.reset} | ${ANSI.dim}${process.cwd()}${ANSI.reset}
`);

  const messages: any[] = [];
  const systemPrompt = `Concise coding assistant. cwd: ${process.cwd()}`;
  const separator = () => console.log(`${ANSI.dim}${"─".repeat(80)}${ANSI.reset}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    separator();
    const input = await new Promise<string>((resolve) => {
      rl.question(`${ANSI.bold}${ANSI.blue}❯${ANSI.reset} `, (answer) => resolve(answer.trim()));
    });
    separator();
    if (!input) continue;
    if (input === "/q" || input === "exit") break;
    if (input === "/c") {
      messages.length = 0;
      console.log(`${ANSI.green}⏺ Cleared conversation${ANSI.reset}`);
      continue;
    }
    messages.push({ role: "user", content: input });
    await runAgentLoop(messages, systemPrompt);
    console.log();
  }
  rl.close();
}

main().catch((e) => { console.error(`${ANSI.red}Fatal: ${e}${ANSI.reset}`); process.exit(1); });
