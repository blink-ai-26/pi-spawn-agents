import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

type AgentStatus = "running" | "done" | "failed";

type AgentRecord = {
	id: string;
	pid: number;
	status: AgentStatus;
	prompt: string;
	model?: string;
	cwd: string;
	outputPath: string;
	startedAt: string;
	finishedAt?: string;
	exitCode?: number;
	error?: string;
};

// ── In-memory registry ─────────────────────────────────────────────────

const agents = new Map<string, AgentRecord>();
const processes = new Map<string, ChildProcess>();

// ── Helpers ────────────────────────────────────────────────────────────

function nowIso(): string {
	return new Date().toISOString();
}

function generateId(prompt: string): string {
	const stopWords = new Set([
		"a", "an", "the", "to", "in", "on", "at", "of", "for",
		"and", "or", "is", "it", "be", "do", "with", "this", "that",
	]);
	const words = prompt
		.replace(/[^a-zA-Z0-9\s]/g, " ")
		.split(/\s+/)
		.map((w) => w.toLowerCase())
		.filter((w) => w.length > 0 && !stopWords.has(w));
	const slug = words.slice(0, 3).join("-") || "agent";

	// Deduplicate
	if (!agents.has(slug)) return slug;
	for (let i = 2; ; i++) {
		const candidate = `${slug}-${i}`;
		if (!agents.has(candidate)) return candidate;
	}
}

function getOutputDir(ctx: ExtensionContext): string {
	return join(ctx.cwd, ".pi", "spawn-agents");
}

async function ensureDir(path: string): Promise<void> {
	await fs.mkdir(path, { recursive: true });
}

async function readOutput(path: string): Promise<string> {
	try {
		return await fs.readFile(path, "utf8");
	} catch {
		return "";
	}
}

function truncateOutput(output: string, maxChars = 50_000): string {
	if (output.length <= maxChars) return output;
	return output.slice(0, maxChars) + "\n\n[output truncated]";
}

// ── Core: spawn a headless agent ───────────────────────────────────────

async function spawnAgent(
	ctx: ExtensionContext,
	prompt: string,
	options?: { model?: string; context?: string },
): Promise<AgentRecord> {
	const id = generateId(prompt);
	const outputDir = getOutputDir(ctx);
	await ensureDir(outputDir);

	const outputPath = join(outputDir, `${id}.out`);
	const fullPrompt = options?.context
		? `${prompt}\n\n---\n\n${options.context}`
		: prompt;

	// Write prompt to file for reference/debugging
	const promptPath = join(outputDir, `${id}.prompt`);
	await fs.writeFile(promptPath, fullPrompt, "utf8");

	// Build pi command args
	const args: string[] = [
		"-p", fullPrompt,
		"--tools", "read,grep,find,ls",
		"--no-session",
	];

	if (options?.model) {
		args.push("--model", options.model);
	}

	// Spawn pi as a background process
	const outStream = await fs.open(outputPath, "w");
	const child = spawn("pi", args, {
		cwd: ctx.cwd,
		stdio: ["ignore", outStream.fd, outStream.fd],
		detached: false,
		env: { ...process.env },
	});

	const record: AgentRecord = {
		id,
		pid: child.pid!,
		status: "running",
		prompt: prompt.length > 200 ? prompt.slice(0, 200) + "…" : prompt,
		model: options?.model,
		cwd: ctx.cwd,
		outputPath,
		startedAt: nowIso(),
	};

	agents.set(id, record);
	processes.set(id, child);

	child.on("exit", (code) => {
		const rec = agents.get(id);
		if (!rec) return;
		rec.exitCode = code ?? 1;
		rec.status = code === 0 ? "done" : "failed";
		rec.finishedAt = nowIso();
		processes.delete(id);
		outStream.close().catch(() => {});
	});

	child.on("error", (err) => {
		const rec = agents.get(id);
		if (!rec) return;
		rec.status = "failed";
		rec.error = err.message;
		rec.finishedAt = nowIso();
		processes.delete(id);
		outStream.close().catch(() => {});
	});

	return record;
}

async function checkAgent(id: string): Promise<{
	ok: boolean;
	id?: string;
	status?: AgentStatus;
	output?: string;
	error?: string;
	startedAt?: string;
	finishedAt?: string;
	prompt?: string;
}> {
	const record = agents.get(id);
	if (!record) {
		return { ok: false, error: `Unknown agent id: ${id}` };
	}

	const output = record.status !== "running"
		? truncateOutput(await readOutput(record.outputPath))
		: undefined;

	return {
		ok: true,
		id: record.id,
		status: record.status,
		output,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		prompt: record.prompt,
		error: record.error,
	};
}

async function waitForAny(
	ids: string[],
	signal?: AbortSignal,
): Promise<{ ok: boolean; id?: string; status?: AgentStatus; output?: string; error?: string }> {
	const unique = [...new Set(ids)];

	// Validate all IDs exist
	const unknown = unique.filter((id) => !agents.has(id));
	if (unknown.length > 0) {
		return { ok: false, error: `Unknown agent id(s): ${unknown.join(", ")}` };
	}

	// Poll until one finishes
	while (true) {
		if (signal?.aborted) {
			return { ok: false, error: "Aborted" };
		}

		for (const id of unique) {
			const record = agents.get(id);
			if (!record) continue;

			if (record.status === "done" || record.status === "failed") {
				const output = truncateOutput(await readOutput(record.outputPath));
				return {
					ok: true,
					id: record.id,
					status: record.status,
					output,
					error: record.error,
				};
			}
		}

		await new Promise((r) => setTimeout(r, 500));
	}
}

function killAgent(id: string): { ok: boolean; error?: string } {
	const record = agents.get(id);
	if (!record) {
		return { ok: false, error: `Unknown agent id: ${id}` };
	}

	const child = processes.get(id);
	if (!child) {
		return { ok: true }; // Already finished
	}

	try {
		child.kill("SIGTERM");
		record.status = "failed";
		record.error = "Killed by user";
		record.finishedAt = nowIso();
		processes.delete(id);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: `Failed to kill: ${err}` };
	}
}

// ── Extension entry point ──────────────────────────────────────────────

export default function spawnAgentsExtension(pi: ExtensionAPI) {

	// ── Tools (LLM-callable) ───────────────────────────────────────────

	pi.registerTool({
		name: "run_agent",
		label: "Run Agent",
		description:
			"Run a headless read-only Pi sub-agent synchronously — blocks until the agent finishes and returns its output. " +
			"The agent has read/grep/find/ls tools only (no file editing). " +
			"Use for quick lookups, code analysis, validation, or any task where you need the answer before continuing. " +
			"Provide a clear, self-contained prompt — the agent has no conversation context from the parent session.",
		parameters: Type.Object({
			prompt: Type.String({ description: "Task prompt for the sub-agent. Must be self-contained — include all necessary context." }),
			context: Type.Optional(Type.String({ description: "Additional context (e.g., a diff, file contents) appended to the prompt." })),
			model: Type.Optional(Type.String({ description: "Model override as provider/modelId (optional, uses parent's default if omitted)." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const record = await spawnAgent(ctx, params.prompt, {
					model: params.model,
					context: params.context,
				});
				const result = await waitForAny([record.id], signal);
				return {
					content: [{
						type: "text",
						text: JSON.stringify(result, null, 2),
					}],
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }, null, 2) }],
				};
			}
		},
	});

	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Spawn a headless read-only Pi sub-agent. The agent runs in the background with read/grep/find/ls tools only (no file editing). " +
			"Returns an agent ID for checking results later. Use for parallel analysis: code review, research, validation. " +
			"Provide a clear, self-contained prompt — the agent has no conversation context from the parent session.",
		parameters: Type.Object({
			prompt: Type.String({ description: "Task prompt for the sub-agent. Must be self-contained — include all necessary context." }),
			context: Type.Optional(Type.String({ description: "Additional context (e.g., a diff, file contents) appended to the prompt." })),
			model: Type.Optional(Type.String({ description: "Model override as provider/modelId (optional, uses parent's default if omitted)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const record = await spawnAgent(ctx, params.prompt, {
					model: params.model,
					context: params.context,
				});
				return {
					content: [{
						type: "text",
						text: JSON.stringify({
							ok: true,
							id: record.id,
							status: record.status,
							pid: record.pid,
							prompt: record.prompt,
						}, null, 2),
					}],
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }, null, 2) }],
				};
			}
		},
	});

	pi.registerTool({
		name: "check_agent",
		label: "Check Agent",
		description:
			"Check status of a spawned sub-agent. Returns status (running/done/failed) and output if finished. " +
			"Output is only returned when the agent has completed — if still running, output will be undefined.",
		parameters: Type.Object({
			id: Type.String({ description: "Agent ID returned by spawn_agent." }),
		}),
		async execute(_toolCallId, params) {
			const result = await checkAgent(params.id);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		},
	});

	pi.registerTool({
		name: "wait_agents",
		label: "Wait Agents",
		description:
			"Block until any of the specified agents finishes (done or failed). Returns the first completed agent's status and output. " +
			"Use after spawning multiple agents in parallel to collect results as they complete.",
		parameters: Type.Object({
			ids: Type.Array(Type.String({ description: "Agent ID" }), {
				description: "Agent IDs to wait on. Returns when any one of them finishes.",
			}),
		}),
		async execute(_toolCallId, params, signal) {
			const result = await waitForAny(params.ids, signal);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		},
	});

	pi.registerTool({
		name: "kill_agent",
		label: "Kill Agent",
		description: "Kill a running spawned agent by ID.",
		parameters: Type.Object({
			id: Type.String({ description: "Agent ID to kill." }),
		}),
		async execute(_toolCallId, params) {
			const result = killAgent(params.id);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		},
	});

	// ── Commands (user-callable) ───────────────────────────────────────

	pi.registerCommand("spawn", {
		description: "Spawn a headless sub-agent: /spawn [-model provider/id] <prompt>",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /spawn [-model provider/id] <prompt>", "error");
				return;
			}

			let model: string | undefined;
			let prompt = args.trim();

			const modelMatch = prompt.match(/(?:^|\s)-model\s+(\S+)/);
			if (modelMatch) {
				model = modelMatch[1];
				prompt = prompt.replace(modelMatch[0], " ").trim();
			}

			if (!prompt) {
				if (ctx.hasUI) ctx.ui.notify("No prompt provided.", "error");
				return;
			}

			try {
				const record = await spawnAgent(ctx, prompt, { model });
				if (ctx.hasUI) {
					ctx.ui.notify(`Spawned agent "${record.id}" (pid ${record.pid})`, "info");
				}
			} catch (err) {
				if (ctx.hasUI) ctx.ui.notify(`Failed: ${err}`, "error");
			}
		},
	});

	pi.registerCommand("spawns", {
		description: "List all spawned agents and their status",
		handler: async (_args, ctx) => {
			if (agents.size === 0) {
				if (ctx.hasUI) ctx.ui.notify("No spawned agents.", "info");
				return;
			}

			const lines: string[] = [];
			for (const [id, record] of agents) {
				const status = record.status;
				const elapsed = record.finishedAt
					? `(${Math.round((new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime()) / 1000)}s)`
					: "(running)";
				lines.push(`${id}: ${status} ${elapsed}`);
				lines.push(`  prompt: ${record.prompt}`);
				if (record.error) lines.push(`  error: ${record.error}`);
			}

			pi.sendMessage({
				customType: "spawn-agents-list",
				content: lines.join("\n"),
				display: true,
			});
		},
	});
}
