# pi-spawn-agents

Headless, read-only sub-agents for the [Pi coding agent](https://github.com/badlogic/pi-mono). Spawn parallel one-shot Pi instances, collect their text output.

## What is this?

A lightweight Pi extension that gives the LLM (and you) the ability to spawn background Pi instances that **read and analyze** code but **never edit files**. Each spawned agent runs `pi -p` in print mode, receives a prompt + context, and returns text output.

Use cases:
- **Code review** — spawn 3 agents in parallel to review a diff for reuse, quality, and efficiency
- **Research** — spawn agents to analyze different parts of a codebase simultaneously
- **Validation** — run parallel checks (tests, linting, security review) as agents

## Install

```bash
# Option 1: Clone and symlink
git clone https://github.com/blink-ai-26/pi-spawn-agents.git
mkdir -p ~/.pi/agent/extensions
ln -s $(pwd)/pi-spawn-agents/extensions/spawn-agents.ts ~/.pi/agent/extensions/

# Option 2: Direct in extensions dir
git clone https://github.com/blink-ai-26/pi-spawn-agents.git ~/.pi/agent/extensions/pi-spawn-agents
```

## Tools

The extension registers 4 tools that the LLM can call:

### `spawn-agent`
Spawn a headless Pi instance with a prompt. Returns an agent ID.

```
spawn-agent(prompt, context?, model?)
→ { ok: true, id: "review-reuse", status: "running" }
```

### `check-agent`
Check if a spawned agent is done and get its output.

```
check-agent(id)
→ { ok: true, status: "done", output: "..." }
```

### `wait-agents`
Block until any of the specified agents finishes. Returns the first completed agent's output.

```
wait-agents(ids)
→ { ok: true, id: "review-reuse", status: "done", output: "..." }
```

### `kill-agent`
Kill a running agent.

```
kill-agent(id)
→ { ok: true }
```

## Commands

### `/spawn`
Interactively spawn an agent: `/spawn [-model provider/id] <prompt>`

### `/spawns`
List all active/completed spawned agents and their status.

## Design

- **Headless**: No tmux, no interactive sessions. Agents run as background `pi -p` processes.
- **Read-only**: Spawned agents use `--tools read,grep,find,ls` — no bash, no write, no edit.
- **Parallel**: Spawn as many as you want. They don't interfere with each other or the parent.
- **No isolation needed**: Since agents are read-only, they all safely share the same working directory.
- **Simple lifecycle**: running → done/failed. No worktrees, no merge flows, no status bars.

## Example: /simplify skill

```
# In a Pi skill that uses spawn-agents:
1. Run git diff to get changed files
2. spawn-agent("Review this diff for code reuse opportunities...", diff)
3. spawn-agent("Review this diff for code quality issues...", diff)
4. spawn-agent("Review this diff for efficiency problems...", diff)
5. wait-agents(all three IDs)
6. Aggregate results, apply the good suggestions
```

## License

MIT
