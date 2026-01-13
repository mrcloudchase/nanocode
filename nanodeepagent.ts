#!/usr/bin/env bun
/**
 * nanodeepagent - minimal claude code alternative in TypeScript
 */

import { readFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import * as readline from "node:readline";

// --- Constants ---

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5";

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  red: "\u001b[31m",
} as const;

// --- Type definitions ---

type ToolArgs = Record<string, unknown>;

type ToolFn = (args: ToolArgs) => string | Promise<string>;

interface ToolParam {
  type: string;
  optional?: boolean;
}

interface Tool {
  description: string;
  params: Record<string, ToolParam>;
  fn: ToolFn;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: ToolArgs }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

interface ToolInputSchema {
  type: "object";
  properties: Record<string, { type: string }>;
  required: string[];
}

interface APITool {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}

interface APIResponse {
  content: ContentBlock[];
}

// --- Tool implementations ---

async function readTool(args: { path: string; offset?: number; limit?: number }): Promise<string> {
  const content = await readFile(args.path, "utf-8");
  const lines = content.split("\n");
  const start = args.offset ?? 0;
  const end = start + (args.limit ?? lines.length);

  return lines
    .slice(start, end)
    .map((line, i) => `${String(start + i + 1).padStart(4)}| ${line}`)
    .join("\n");
}

async function writeTool(args: { path: string; content: string }): Promise<string> {
  await writeFile(args.path, args.content, "utf-8");
  return "ok";
}

async function editTool(args: { path: string; old: string; new: string; all?: boolean }): Promise<string> {
  const content = await readFile(args.path, "utf-8");
  const { old: oldStr, new: newStr, all } = args;

  if (!content.includes(oldStr)) {
    return "error: old_string not found";
  }

  const count = (content.match(new RegExp(escapeRegExp(oldStr), "g")) ?? []).length;
  if (!all && count > 1) {
    return `error: old_string appears ${count} times, must be unique (use all=true)`;
  }

  const replacement = all ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
  await writeFile(args.path, replacement, "utf-8");
  return "ok";
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function globTool(args: { pat: string; path?: string }): Promise<string> {
  const pattern = `${args.path ?? "."}/${args.pat}`.replace("//", "/");
  const glob = new Bun.Glob(pattern);
  const files: string[] = [];

  for await (const file of glob.scan()) {
    files.push(file);
  }

  const sorted = files.sort((a, b) => getFileModTime(b) - getFileModTime(a));
  return sorted.join("\n") || "none";
}

function getFileModTime(filepath: string): number {
  try {
    const stats = execSync(
      `test -f "${filepath}" && stat -f %m "${filepath}" 2>/dev/null || stat -c %Y "${filepath}" 2>/dev/null || echo 0`,
      { encoding: "utf-8" }
    );
    return Number(stats.trim()) || 0;
  } catch {
    return 0;
  }
}

async function grepTool(args: { pat: string; path?: string }): Promise<string> {
  const pattern = new RegExp(args.pat);
  const glob = new Bun.Glob(`${args.path ?? "."}/**`);
  const hits: string[] = [];

  for await (const file of glob.scan()) {
    if (file.includes("node_modules")) continue;

    try {
      const content = await readFile(file, "utf-8");
      content.split("\n").forEach((line, i) => {
        if (pattern.test(line)) {
          hits.push(`${file}:${i + 1}:${line.trim()}`);
        }
      });
    } catch {
      // Skip unreadable files
    }
  }

  return hits.slice(0, 50).join("\n") || "none";
}

async function bashTool(args: { cmd: string }): Promise<string> {
  try {
    const result = execSync(args.cmd, { encoding: "utf-8", timeout: 30000 });
    return result.trim() || "(empty)";
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    return (err.stdout || err.stderr || String(error)).trim();
  }
}

// --- Tool registry ---

const TOOLS: Record<string, Tool> = {
  read: {
    description: "Read file with line numbers (file path, not directory)",
    params: { path: { type: "string" }, offset: { type: "integer", optional: true }, limit: { type: "integer", optional: true } },
    fn: (args: ToolArgs) => readTool(args as any),
  },
  write: {
    description: "Write content to file",
    params: { path: { type: "string" }, content: { type: "string" } },
    fn: (args: ToolArgs) => writeTool(args as any),
  },
  edit: {
    description: "Replace old with new in file (old must be unique unless all=true)",
    params: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" }, all: { type: "boolean", optional: true } },
    fn: (args: ToolArgs) => editTool(args as any),
  },
  glob: {
    description: "Find files by pattern, sorted by mtime",
    params: { pat: { type: "string" }, path: { type: "string", optional: true } },
    fn: (args: ToolArgs) => globTool(args as any),
  },
  grep: {
    description: "Search files for regex pattern",
    params: { pat: { type: "string" }, path: { type: "string", optional: true } },
    fn: (args: ToolArgs) => grepTool(args as any),
  },
  bash: {
    description: "Run shell command",
    params: { cmd: { type: "string" } },
    fn: (args: ToolArgs) => bashTool(args as any),
  },
};

// --- Helpers ---

function buildAPISchema(): APITool[] {
  return Object.entries(TOOLS).map(([name, { description, params }]) => {
    const properties: Record<string, { type: string }> = {};
    const required: string[] = [];

    for (const [paramName, { type, optional }] of Object.entries(params)) {
      properties[paramName] = { type };
      if (!optional) required.push(paramName);
    }

    return {
      name,
      description,
      input_schema: { type: "object", properties, required },
    };
  });
}

async function runTool(name: string, args: ToolArgs): Promise<string> {
  const tool = TOOLS[name];
  if (!tool) return `error: unknown tool ${name}`;
  try {
    return await tool.fn(args);
  } catch (error) {
    return `error: ${error}`;
  }
}

async function callAPI(messages: Message[], systemPrompt: string): Promise<APIResponse> {
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
      tools: buildAPISchema(),
    }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as APIResponse;
}

function separator(): string {
  const columns = process.stdout.columns || 80;
  return `${ANSI.dim}${"─".repeat(Math.min(columns, 80))}${ANSI.reset}`;
}

function renderMarkdown(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, `${ANSI.bold}$1${ANSI.reset}`);
}

// --- Main REPL ---

async function main(): Promise<void> {
  const logo = `
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
`;

  console.log(logo);

  const messages: Message[] = [];
  const systemPrompt = `Concise coding assistant. cwd: ${process.cwd()}`;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  while (true) {
    try {
      console.log(separator());

      const input = await new Promise<string>((resolve) => {
        rl.question(`${ANSI.bold}${ANSI.blue}❯${ANSI.reset} `, (answer) => {
          resolve(answer.trim());
        });
      });

      console.log(separator());

      if (!input) continue;
      if (input === "/q" || input === "exit") break;
      if (input === "/c") {
        messages.length = 0;
        console.log(`${ANSI.green}⏺ Cleared conversation${ANSI.reset}`);
        continue;
      }

      messages.push({ role: "user", content: input });

      // Agentic loop: execute tools until response is complete
      while (true) {
        const response = await callAPI(messages, systemPrompt);
        const toolResults: ContentBlock[] = [];

        for (const block of response.content) {
          if (block.type === "text") {
            console.log(`\n${ANSI.cyan}⏺${ANSI.reset} ${renderMarkdown(block.text)}`);
          } else if (block.type === "tool_use") {
            const args = Object.values(block.input);
            const preview = String(args[0] ?? "").slice(0, 50);

            console.log(
              `\n${ANSI.green}⏺ ${block.name.charAt(0).toUpperCase() + block.name.slice(1)}${ANSI.reset}(${ANSI.dim}${preview}${ANSI.reset})`
            );

            const result = await runTool(block.name, block.input);
            const lines = result.split("\n");
            const firstLine = lines[0] ?? "";
            let resultPreview = firstLine.slice(0, 60);

            if (lines.length > 1) {
              resultPreview += ` ... +${lines.length - 1} lines`;
            } else if (firstLine.length > 60) {
              resultPreview += "...";
            }

            console.log(`  ${ANSI.dim}⎿  ${resultPreview}${ANSI.reset}`);

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: result,
            });
          }
        }

        messages.push({ role: "assistant", content: response.content });

        if (toolResults.length === 0) break;

        messages.push({ role: "user", content: toolResults });
      }

      console.log();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") break;
      console.log(`${ANSI.red}⏺ Error: ${error}${ANSI.reset}`);
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error(`${ANSI.red}Fatal error: ${err}${ANSI.reset}`);
  process.exit(1);
});
