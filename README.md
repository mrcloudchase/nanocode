# nanocode

> **Credit**: This project was inspired by [nanocode](https://github.com/1rgs/nanocode) - thanks for the original idea!
>
> **Want more?** If you're looking to build a more comprehensive version with a proper deep agent harness, check out [Deep Agent SDK](https://deepagentsdk.dev/docs).

A single-file AI coding agent with full OpenClaw-level architecture. Built with TypeScript and Bun, nanocode packs a gateway control plane, multi-provider streaming, Docker sandboxing, platform adapters, memory system, and daemon mode into one `nanocode.ts` file.

## Features

### Core Agent
- **Agentic Loop**: Continuously executes tools until tasks complete
- **Streaming**: Real-time token-by-token output (Anthropic SSE + OpenAI streaming)
- **Parallel Tool Execution**: Multiple tool calls run concurrently via `Promise.all`
- **Multi-Provider**: Anthropic Claude and OpenAI GPT models, switchable at runtime with `/model`
- **Sub-Agents**: Delegate research tasks to isolated sub-agents with their own context window
- **Cost Tracking**: Per-session input/output token counts and USD cost estimates

### Gateway & Networking
- **WebSocket Gateway**: Central control plane with JSON Schema validation and idempotency keys
- **Three Operating Modes**: Daemon (headless), Thin Client (connect to running daemon), Embedded (in-process gateway + REPL)
- **Daemon Mode**: `--daemon` flag, PID file tracking, log file, CLI subcommands (`daemon start/stop/status`)
- **Webhooks**: POST `/webhook` endpoint with secret-based auth for external triggers
- **Remote Access**: Tailscale Serve (tailnet HTTPS) and Tailscale Funnel (public HTTPS) support

### Platform Adapters
- **Slack**: Socket Mode, allowlists (user + channel), rate limiting, file attachment handling, message chunking
- **Discord**: Raw WebSocket with gateway heartbeat, DM and mention-based routing

### Memory & Context
- **SQLite Memory**: FTS5 full-text search + vector embeddings (OpenAI/Gemini auto-detected)
- **Semantic Search**: Cosine similarity over embeddings with relevance threshold filtering
- **Memory Files**: File watcher with 1.5s debounce auto-indexes `~/.nanocode/memory/*.md`
- **MEMORY.md**: Long-term curated facts injected into main session prompts
- **Daily Notes**: Auto-generated `YYYY-MM-DD.md` logs from memory flush during compaction
- **Context Management**: Anthropic native token counting, auto-compaction with summary, tool result summarization

### System Prompt Composition
- **AGENTS.md**: Core operational instructions (global + workspace + per-agent routing override)
- **SOUL.md**: Personality and tone (global + workspace)
- **TOOLS.md**: User-specific tool conventions (global + workspace)
- **Skills**: Keyword-matched `SKILL.md` files injected per-turn from `~/.nanocode/skills/` and `.nanocode/skills/`

### Security & Sandboxing
- **Docker Sandboxing**: Ephemeral containers per session (512MB memory, 1 CPU, no network by default)
- **7-Layer Tool Policy**: Tool Profile > Provider Profile > Global > Provider > Agent > Group > Sandbox
- **Authentication**: Password auth, device pairing (cryptographic challenge-response), local auto-approval
- **Prompt Injection Defense**: Source metadata wrapping, structured `<tool_result>` tags, context isolation
- **Access Control**: Slack allowlists, rate limiting, session-type tool restrictions

### Canvas (A2UI)
- **Agent-to-User Interface**: Separate server (port 18793) renders agent-generated HTML in a browser
- **Interactive Elements**: `a2ui-action` and `a2ui-param-*` attributes on HTML elements trigger tool calls back to the agent

### Voice
- **Push-to-Talk**: `/voice` toggle, records via `sox`, transcribes with OpenAI Whisper
- **Text-to-Speech**: Responses played via `ffplay` using OpenAI TTS (configurable voice, speed, model)

### Multi-Agent Routing
- **Pattern Matching**: Map session ID patterns (`dm:slack:*:U01ABC`) to workspace, model, and agentsFile overrides
- **Isolated Workspaces**: Different sessions operate in different directories with different configurations

### Extensions
- **Plugin System**: Load `.ts`/`.js` files from `~/.nanocode/extensions/` and `.nanocode/extensions/`
- **Registration API**: `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerHook`
- **Lifecycle Hooks**: `session_start`, `agent_start`, `turn_start`, `tool_call`, `tool_result`, `turn_end`, `agent_end`, `context_before_send`, `session_compact`, `session_shutdown`, `model_select`
- **User Interaction**: `confirm()`, `select()`, `notify()` for interactive extensions

### Cron Jobs
- **Scheduled Tasks**: Cron expression parser with minute-level granularity
- **Persistent Storage**: Jobs stored in SQLite, survive restarts
- **Agent-Driven**: Cron tasks are injected as user messages into target sessions

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.3.4 or later
- Anthropic API key (and/or OpenAI API key)

### Installation

```bash
git clone https://github.com/mrcloudchase/nanocode.git
cd nanocode
```

### Configuration

Create `~/.nanocode/.env` for API keys:

```bash
mkdir -p ~/.nanocode
cat > ~/.nanocode/.env << 'EOF'
ANTHROPIC_API_KEY=your_anthropic_key
OPENAI_API_KEY=your_openai_key          # optional: for voice, embeddings
GEMINI_API_KEY=your_gemini_key          # optional: for embeddings
NANOCODE_SLACK_APP_TOKEN=xapp-...       # optional: Slack Socket Mode
NANOCODE_SLACK_BOT_TOKEN=xoxb-...       # optional: Slack bot
NANOCODE_DISCORD_BOT_TOKEN=...          # optional: Discord bot
EOF
```

Optionally create `~/.nanocode/config.json` to override defaults:

```json
{
  "gateway": { "port": 18789, "host": "127.0.0.1" },
  "providers": {
    "anthropic": { "defaultModel": "claude-sonnet-4-5" }
  },
  "memory": { "compactThreshold": 150000 },
  "voice": { "model": "tts-1", "speed": 1, "voice": "alloy" },
  "agents": {
    "mapping": {
      "dm:slack:*:U01TRUSTED": { "workspace": "/home/user/project-a" }
    }
  }
}
```

### Running

```bash
# Interactive mode (embedded gateway)
bun nanocode.ts

# Daemon mode (headless)
bun nanocode.ts --daemon

# Daemon management
bun nanocode.ts daemon start
bun nanocode.ts daemon stop
bun nanocode.ts daemon status

# Compile to standalone binary
bun build nanocode.ts --compile --outfile nanocode
./nanocode
```

## REPL Commands

| Command | Description |
|---------|-------------|
| `/q` or `exit` | Quit |
| `/c` | Clear conversation history |
| `/cost` | Show token usage and cost |
| `/model [provider:]model` | Switch model (e.g., `/model openai:gpt-4o`) |
| `/sessions` | List active and saved sessions |
| `/save name` | Save current session to disk |
| `/load name` | Load a saved session |
| `/tree` | Show session history tree |
| `/fork [label]` | Fork current session |
| `/goto N` | Navigate to entry N in session history |
| `/memory query` | Search long-term memory |
| `/voice` | Toggle push-to-talk voice mode |
| `/daemon start\|stop\|status` | Manage daemon process |

## Tools

| Tool | Description | Session |
|------|-------------|---------|
| `read` | Read file with line numbers | all |
| `write` | Write content to file | main |
| `edit` | Find-and-replace in file | main |
| `multiedit` | Multiple find-and-replace edits in one operation | main |
| `glob` | Find files by pattern | all |
| `grep` | Search files with regex | all |
| `bash` | Execute shell commands (sandboxed in dm/group) | main |
| `websearch` | Search the web via DuckDuckGo | all |
| `webfetch` | Fetch URL and convert to markdown | all |
| `browser` | Browser automation via Chrome DevTools Protocol | all |
| `canvas` | Render HTML in the Canvas browser UI | all |
| `subagent` | Delegate a task to an isolated sub-agent | all |
| `memory_search` | Search long-term memory | all |
| `memory_write` | Save information to long-term memory | all |
| `sessions_list` | List all active sessions | main |
| `sessions_send` | Send a message to another session | main |
| `sessions_history` | Read another session's message history | main |
| `sessions_spawn` | Create a new session with an initial task | main |
| `cron_create` | Schedule a recurring task (cron expression) | main |
| `cron_list` | List all scheduled cron jobs | all |
| `cron_delete` | Delete a cron job | main |

## Architecture

### Single-File Design

The entire application is contained in `nanocode.ts` (~2200 lines):

```
Config & types → .env loading → Daemon management → API layer (Anthropic + OpenAI streaming)
→ Context management (compaction, summarization) → System prompt composition
→ Session persistence (JSONL tree) → Memory system (SQLite + embeddings)
→ Cron jobs → Extension system → Security & sandboxing (Docker, 7-layer policy)
→ Gateway (WebSocket server) → Slack adapter → Discord adapter
→ Canvas server (A2UI) → Browser automation (CDP) → Tools
→ Agent loop → Voice (STT/TTS) → REPL commands → REPL over WebSocket → Main
```

### Operating Modes

- **Embedded**: No daemon running. Starts gateway, adapters, canvas, and all subsystems in-process, then connects REPL as a WebSocket client.
- **Thin Client**: Daemon already running. REPL connects to the existing gateway. Local commands (`/cost`, `/sessions`) execute locally; chat flows through the gateway.
- **Daemon**: Headless. `--daemon` flag starts all subsystems without a REPL. PID file at `~/.nanocode/daemon.pid`, logs at `~/.nanocode/daemon.log`.

### Message Flow

```
User input → REPL → WebSocket → Gateway → Session resolution
→ Context assembly (AGENTS.md + SOUL.md + TOOLS.md + skills + memory)
→ Streaming LLM call → Tool execution (parallel, sandboxed) → Response
→ WebSocket → REPL → stdout (streaming)
```

### Session Types & Security

| Type | Tools | Sandboxing | Use Case |
|------|-------|------------|----------|
| `main` | All tools | None (host execution) | Local REPL operator |
| `dm` | Read-only (configurable via policy) | Docker container | Slack/Discord DMs |
| `group` | Read-only (configurable via policy) | Docker container | Slack/Discord channels |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (required for Claude models) |
| `OPENAI_API_KEY` | OpenAI API key (for GPT models, voice, embeddings) |
| `GEMINI_API_KEY` | Google Gemini API key (for embeddings) |
| `NANOCODE_GATEWAY_PORT` | Gateway port override (default: 18789) |
| `NANOCODE_GATEWAY_HOST` | Gateway host override (default: 127.0.0.1) |
| `NANOCODE_GATEWAY_PASSWORD` | Password for remote gateway auth |
| `NANOCODE_REMOTE_MODE` | Remote access: `local`, `tailscale-serve`, `tailscale-funnel` |
| `NANOCODE_COMPACT_THRESHOLD` | Token count to trigger compaction |
| `NANOCODE_MEMORY_MAX_TOKENS` | Max tokens for memory injection |
| `NANOCODE_SANDBOX_NETWORK` | Set `true` to allow network in sandboxed containers |
| `NANOCODE_WEBHOOK_SECRET` | Secret for webhook endpoint auth |
| `NANOCODE_SLACK_APP_TOKEN` | Slack app-level token (Socket Mode) |
| `NANOCODE_SLACK_BOT_TOKEN` | Slack bot token |
| `NANOCODE_SLACK_ALLOW_USERS` | Comma-separated Slack user IDs for allowlist |
| `NANOCODE_SLACK_ALLOW_CHANNELS` | Comma-separated Slack channel IDs for allowlist |
| `NANOCODE_DISCORD_BOT_TOKEN` | Discord bot token |

## Building for Different Platforms

```bash
# macOS ARM64 (default on Apple Silicon)
bun build nanocode.ts --compile --outfile nanocode

# x86_64 (Intel)
bun build nanocode.ts --compile --target=x86_64 --outfile nanocode-x64

# Linux ARM64
bun build nanocode.ts --compile --target=linux-arm64 --outfile nanocode-linux-arm64
```

## License

MIT

## Acknowledgments

Inspired by Claude Code and [OpenClaw](https://ppaolo.substack.com/p/openclaw-system-architecture-overview). Built as a demonstration that a full-featured AI agent architecture can live in a single file.
