#!/usr/bin/env bun
/**
 * nanodeepagent - minimal deep agent in TypeScript
 */
import { readFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import * as readline from "node:readline";

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};

// --- Tool implementations ---
const TOOLS: Record<string, { desc: string; params: string[]; fn: (args: any) => Promise<string> | string }> = {
  read: {
    desc: "Read file with line numbers",
    params: ["path"],
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
    fn: async (args) => {
      const files: string[] = [];
      for await (const file of new Bun.Glob(`${args.path ?? "."}/${args.pat}`).scan()) {
        files.push(file);
      }
      return files.join("\n") || "none";
    },
  },
  grep: {
    desc: "Search files for regex",
    params: ["pat"],
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
    fn: (args) => execSync(args.cmd, { encoding: "utf-8", timeout: 30000 }).trim(),
  },
};

// --- API ---
function buildToolSchema() {
  return Object.entries(TOOLS).map(([name, { desc, params }]) => ({
    name,
    description: desc,
    input_schema: {
      type: "object",
      properties: Object.fromEntries(params.map((p) => [p, { type: "string" }])),
      required: params,
    },
  }));
}

async function callAPI(messages: any[], systemPrompt: string) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      system: systemPrompt,
      messages,
      tools: buildToolSchema(),
      stream: true,
    }),
  });
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

// --- Main ---
async function main() {
  console.log(`
${ANSI.bold}${ANSI.cyan}
 ███╗   ██╗ █████╗ ███╗   ██╗ ██████╗
 ████╗  ██║██╔══██╗████╗  ██║██╔═══██╗
 ██╔██╗ ██║███████║██╔██╗ ██║██║   ██║
 ██║╚██╗██║██╔══██║██║╚██╗██║██║   ██║
 ██║ ╚████║██║  ██║██║ ╚████║╚██████╔╝
 ╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝
 ██████╗ ███████╗███████╗██████╗  █████╗  ██████╗ ███████╗███╗   ██╗████████╗
 ██╔══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
 ██║  ██║█████╗  █████╗  ██████╔╝███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║
 ██║  ██║██╔══╝  ██╔══╝  ██╔═══╝ ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║
 ██████╔╝███████╗███████╗██║     ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║
 ╚═════╝ ╚══════╝╚══════╝╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝
${ANSI.reset}
${ANSI.dim}Deep Agent${ANSI.reset} | ${ANSI.dim}${MODEL}${ANSI.reset} | ${ANSI.dim}${process.cwd()}${ANSI.reset}
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

    // Agentic loop
    while (true) {
      const response = await callAPI(messages, systemPrompt);
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason !== "tool_use") break;

      const toolResults = await Promise.all(
        response.content.filter((b: any) => b.type === "tool_use").map(async (block: any) => {
          const preview = String(Object.values(block.input)[0] ?? "").slice(0, 50);
          console.log(`\n${ANSI.green}⏺ ${block.name}${ANSI.reset}(${ANSI.dim}${preview}${ANSI.reset})`);
          try {
            const result = await (TOOLS[block.name]?.fn(block.input) ?? `unknown tool: ${block.name}`);
            const lines = result.split("\n");
            console.log(`  ${ANSI.dim}⎿  ${lines[0].slice(0, 60)}${lines.length > 1 ? ` +${lines.length - 1} lines` : ""}${ANSI.reset}`);
            return { type: "tool_result", tool_use_id: block.id, content: result };
          } catch (err: any) {
            return { type: "tool_result", tool_use_id: block.id, content: String(err), is_error: true };
          }
        }),
      );
      messages.push({ role: "user", content: toolResults });
    }
    console.log();
  }
  rl.close();
}

main().catch((e) => { console.error(`${ANSI.red}Fatal: ${e}${ANSI.reset}`); process.exit(1); });