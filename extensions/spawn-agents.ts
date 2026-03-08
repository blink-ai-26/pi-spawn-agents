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

// ── Core ───────────────────────────────────────────────────────────────

async function spawnOne(
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

	const promptPath = join(outputDir, `${id}.prompt`);
	await fs.writeFile(promptPath, fullPrompt, "utf8");

	const args: string[] = [
		"-p", fullPrompt,
		"--tools", "read,grep,find,ls",
		"--no-session",
	];

	if (options?.model) {
		args.push("--model", options.model);
	}

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

async function waitForAll(
	ids: string[],
	signal?: AbortSignal,
): Promise<Array<{ id: string; status: AgentStatus; output: string; error?: string }>> {
	const unknown = ids.filter((id) => !agents.has(id));
	if (unknown.length > 0) {
		throw new Error(`Unknown agent id(s): ${unknown.join(", ")}`);
	}

	while (true) {
		if (signal?.aborted) throw new Error("Aborted");

		const allDone = ids.every((id) => {
			const record = agents.get(id);
			return record && (record.status === "done" || record.status === "failed");
		});

		if (allDone) {
			return Promise.all(
				ids.map(async (id) => {
					const record = agents.get(id)!;
					const output = truncateOutput(await readOutput(record.outputPath));
					return { id: record.id, status: record.status, output, error: record.error };
				}),
			);
		}

		await new Promise((r) => setTimeout(r, 500));
	}
}

function killAgent(id: string): { ok: boolean; error?: string } {
	const record = agents.get(id);
	if (!record) return { ok: false, error: `Unknown agent id: ${id}` };

	const child = processes.get(id);
	if (!child) return { ok: true };

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

// ── Extension ──────────────────────────────────────────────────────────

export default function spawnAgentsExtension(pi: ExtensionAPI) {

	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Spawn one or more headless read-only Pi sub-agents and wait for all results (synchronous). " +
			"Each agent has read/grep/find/ls tools only (no file editing). " +
			"Pass a single prompt string for one agent, or an array of {prompt, context?} objects to run multiple agents in parallel. " +
			"Blocks until all agents finish, then returns all outputs. " +
			"Provide clear, self-contained prompts — agents have no conversation context from the parent session.",
		parameters: Type.Object({
			prompt: Type.Optional(Type.String({ description: "Task prompt for a single sub-agent. Use this OR agents, not both." })),
			context: Type.Optional(Type.String({ description: "Additional context appended to the prompt (only with single prompt)." })),
			agents: Type.Optional(Type.Array(
				Type.Object({
					prompt: Type.String({ description: "Task prompt for this sub-agent." }),
					context: Type.Optional(Type.String({ description: "Additional context appended to the prompt." })),
				}),
				{ description: "Array of agent tasks to run in parallel. Use this OR prompt, not both.", minItems: 1 },
			)),
			model: Type.Optional(Type.String({ description: "Model override as provider/modelId (optional)." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let records: AgentRecord[] = [];
			try {
				const hasPrompt = typeof params.prompt === "string" && params.prompt.trim().length > 0;
				const hasAgents = Array.isArray(params.agents) && params.agents.length > 0;
				if (hasPrompt === hasAgents) {
					return {
						content: [{
							type: "text",
							text: JSON.stringify({ ok: false, error: "Provide exactly one of prompt or agents." }, null, 2),
						}],
					};
				}

				const tasks: Array<{ prompt: string; context?: string }> = hasAgents
					? params.agents
					: [{ prompt: params.prompt.trim(), context: params.context }];

				records = await Promise.all(
					tasks.map((t) => spawnOne(ctx, t.prompt, { model: params.model, context: t.context })),
				);

				const results = await waitForAll(records.map((r) => r.id), signal);

				return {
					content: [{
						type: "text",
						text: JSON.stringify({ ok: true, results }, null, 2),
					}],
				};
			} catch (err) {
				if (signal?.aborted) {
					for (const record of records) killAgent(record.id);
				}
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }, null, 2) }],
				};
			}
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

	// ── Commands ────────────────────────────────────────────────────────

	pi.registerCommand("spawn", {
		description: "Spawn a sub-agent: /spawn [-model provider/id] <prompt>",
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
				if (ctx.hasUI) ctx.ui.notify("Spawning agent…", "info");
				const record = await spawnOne(ctx, prompt, { model });
				const results = await waitForAll([record.id]);

				pi.sendMessage({
					customType: "spawn-agent-result",
					content: `Agent "${record.id}" finished:\n\n${results[0].output}`,
					display: true,
				});
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
			for (const [_id, record] of agents) {
				const elapsed = record.finishedAt
					? `(${Math.round((new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime()) / 1000)}s)`
					: "(running)";
				lines.push(`${record.id}: ${record.status} ${elapsed}`);
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
