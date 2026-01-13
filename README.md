# nanodeepagent

![nanodeepagent](./screenshot.png)

> **Credit**: This project was inspired by [nanocode](https://github.com/1rgs/nanocode) - thanks for the original idea!
>
> **Want more?** If you're looking to build a more comprehensive version with a proper deep agent harness, check out [Deep Agent SDK](https://deepagentsdk.dev/docs).

A minimal Claude Code alternative - an interactive terminal-based coding assistant with agentic tool use. Built with TypeScript and Bun, nanodeepagent provides a REPL interface where Claude can read, edit, search files, and execute shell commands autonomously.

## Features

- 🤖 **Agentic Loop**: Claude continuously executes tools until tasks complete
- 📁 **File Operations**: Read, write, and edit files with line numbers
- 🔍 **Code Search**: Grep patterns and glob file matching
- 💻 **Shell Integration**: Execute bash commands directly
- 🎨 **Rich Terminal UI**: ASCII art, colored output, and Markdown rendering
- ⚡ **Bun Runtime**: Fast TypeScript execution and standalone binary compilation

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.3.4 or later
- Anthropic API key

### Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd nanodeepagent
```

1. Set up your API key:

```bash
echo "ANTHROPIC_API_KEY=your_key_here" > .env
```

### Running

#### Development mode (interpreted)

```bash
bun nanodeepagent.ts
```

#### Compile to standalone binary

```bash
bun build nanodeepagent.ts --compile --outfile nanodeepagent
./nanodeepagent
```

## Usage

Once running, you'll see the nanodeepagent logo and a prompt (`❯`). Simply type your coding request, and Claude will use tools autonomously to complete the task.

### REPL Commands

- `/q` or `exit` - Quit the application
- `/c` - Clear conversation history
- `Enter` (empty) - Skip to next prompt

### Example Session

```
❯ Create a hello world function in hello.ts

⏺ Write(hello.ts)
  ⎿  ok

⏺ I've created a hello.ts file with a simple hello world function...
```

## Tool Capabilities

nanodeepagent provides Claude with six powerful tools:

| Tool | Description | Parameters |
|------|-------------|------------|
| `read` | Read file with line numbers | `path`, `offset?`, `limit?` |
| `write` | Write content to file | `path`, `content` |
| `edit` | Replace text in file | `path`, `old`, `new`, `all?` |
| `glob` | Find files by pattern | `pat`, `path?` |
| `grep` | Search files with regex | `pat`, `path?` |
| `bash` | Execute shell commands | `cmd` |

All tools execute with the current working directory as context.

## Architecture

### Single-File Design

The entire application is contained in `nanodeepagent.ts` with clear sections:

- Constants (API URL, model, ANSI colors)
- Type definitions (TypeScript interfaces)
- Tool implementations (six file/system tools)
- Tool registry (centralized metadata)
- Helper functions (API calls, formatting)
- Main REPL (interactive loop)

### Agentic Loop

The core pattern:

1. User provides request
2. Claude responds with text and/or tool calls
3. Tools execute and results are returned to Claude
4. Loop continues until Claude responds without tools
5. Task complete ✅

This allows Claude to chain multiple operations autonomously (e.g., read file → analyze → edit file → verify).

## Configuration

### Model

Default: `claude-sonnet-4-5`

To change the model, edit the `MODEL` constant in `nanodeepagent.ts`:

```typescript
const MODEL = "claude-sonnet-4-5";
```

### API Endpoint

The application uses Anthropic's Messages API:

```
https://api.anthropic.com/v1/messages
```

### Environment Variables

- `ANTHROPIC_API_KEY` (required) - Your Anthropic API key

## Development

### Type Checking

```bash
bun --print "import './nanodeepagent.ts'"
```

### Building for Different Platforms

```bash
# macOS ARM64 (default on Apple Silicon)
bun build nanodeepagent.ts --compile --outfile nanodeepagent

# x86_64 (Intel)
bun build nanodeepagent.ts --compile --target=x86_64 --outfile nanodeepagent-x64

# Linux ARM64
bun build nanodeepagent.ts --compile --target=linux-arm64 --outfile nanodeepagent-linux-arm64
```

### Project Structure

```
nanodeepagent/
├── nanodeepagent.ts    # Main application (single file)
├── package.json        # Dependencies
├── tsconfig.json       # TypeScript config
├── .env               # API key (gitignored)
├── README.md          # This file
└── CLAUDE.md          # Developer guide for Claude Code
```

## Technical Details

### Dependencies

- `@types/bun` - Bun TypeScript definitions
- `typescript` ^5 - TypeScript compiler

### Runtime

Built with Bun, which provides:

- Fast TypeScript execution
- Built-in bundler and compiler
- Native APIs (Glob, file I/O)
- Standalone binary compilation (~60MB, runtime included)

### API Integration

- **Max tokens**: 8192
- **System prompt**: Includes current working directory
- **Tool schema**: Auto-generated from tool registry
- **Message format**: Anthropic Messages API with tool use

## Error Handling

- Tool errors return as strings (prefixed with `"error: "`)
- API errors display with status and message
- Shell commands timeout after 30 seconds
- File operations handle permissions gracefully

## Limitations

- Single conversation thread (use `/c` to clear)
- No conversation persistence between sessions
- Tool results limited (grep: 50 matches, text previews: 60 chars)
- Shell commands limited to 30-second execution
- No streaming output (results display after completion)

## Contributing

This is a minimal implementation designed for simplicity and clarity. The entire codebase is ~375 lines in a single file, making it easy to understand, modify, and extend.

To add a new tool:

1. Implement the function
2. Add entry to `TOOLS` registry
3. Claude will automatically have access

## License

[Your license here]

## Acknowledgments

Inspired by Claude Code and built as a demonstration of agentic tool use with the Anthropic API.

---

**Model**: claude-sonnet-4-5 | **Runtime**: Bun | **Language**: TypeScript
