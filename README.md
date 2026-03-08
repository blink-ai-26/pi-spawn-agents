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
# Via Pi's package manager (recommended)
pi install git:github.com/blink-ai-26/pi-spawn-agents

# Or try without installing
pi -e git:github.com/blink-ai-26/pi-spawn-agents

# Or clone and install locally
git clone https://github.com/blink-ai-26/pi-spawn-agents.git
pi install ./pi-spawn-agents
```

## Tools

### `spawn_agent`

Spawn one or more read-only sub-agents and wait for results (synchronous).

**Single agent:**
```
spawn_agent(prompt: "What does this function do?", context?: "...")
→ { ok: true, results: [{ id, status, output }] }
```

**Multiple agents in parallel:**
```
spawn_agent(agents: [
  { prompt: "Review for code reuse", context: diff },
  { prompt: "Review for quality", context: diff },
  { prompt: "Review for efficiency", context: diff }
])
→ { ok: true, results: [{ id, status, output }, ...] }
```

Blocks until all agents finish. Each agent has `read/grep/find/ls` tools only — no file editing.

### `kill_agent`

Kill a running agent by ID.

```
kill_agent(id: "review-reuse")
→ { ok: true }
```

## Commands

- `/spawn [-model provider/id] <prompt>` — spawn a single agent interactively
- `/spawns` — list all agents and their status

## Design

- **2 tools, not 7.** One tool spawns agents (one or many), the other kills them.
- **Synchronous.** Agents block until done. No async polling, no callbacks.
- **Read-only.** Spawned agents can read files but never edit them.
- **Parallel.** Pass multiple prompts to run agents simultaneously.
- **No isolation needed.** Read-only agents safely share the working directory.

## Example: /simplify skill

```
1. Run git diff to get changed files
2. spawn_agent(agents: [
     { prompt: "Review this diff for code reuse opportunities...", context: diff },
     { prompt: "Review this diff for code quality issues...", context: diff },
     { prompt: "Review this diff for efficiency problems...", context: diff }
   ])
3. All 3 run in parallel, results come back together
4. Aggregate results, apply the good suggestions
```

## License

MIT
