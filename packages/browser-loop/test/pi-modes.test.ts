import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface FakeServer {
	url: string;
	payloads: unknown[];
	deletedBrowsers: string[];
	close(): Promise<void>;
}

async function startFakeServer(): Promise<FakeServer> {
	const payloads: unknown[] = [];
	const deletedBrowsers: string[] = [];
	const server = createServer(async (request, response) => {
		const body = await readBody(request);
		const send = (value: unknown) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(value));
		};
		if (request.method === "POST" && request.url === "/chat/completions") {
			payloads.push(JSON.parse(body || "{}"));
			response.writeHead(200, { "content-type": "text/event-stream" });
			const isFollowup =
				Array.isArray((payloads.at(-1) as { messages?: Array<{ role?: string }> }).messages) &&
				(payloads.at(-1) as { messages: Array<{ role?: string }> }).messages.some((message) => message.role === "tool");
			if (!isFollowup) {
				response.write(
					`data: ${JSON.stringify(completion({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "playwright_execute", arguments: '{"code":"return 7"}' } }] }, null))}\n\n`,
				);
				response.write(`data: ${JSON.stringify(completion({}, "tool_calls"))}\n\n`);
			} else {
				response.write(`data: ${JSON.stringify(completion({ role: "assistant", content: "browser tool completed" }, null))}\n\n`);
				response.write(`data: ${JSON.stringify(completion({}, "stop"))}\n\n`);
			}
			response.end("data: [DONE]\n\n");
			return;
		}
		if (request.method === "POST" && request.url === "/browsers") {
			return send({ session_id: "browser_test", created_at: "2026-01-01T00:00:00Z", browser_live_view_url: "https://live.test" });
		}
		if (request.method === "POST" && request.url === "/browsers/browser_test/playwright/execute") {
			return send({ success: true, result: 7, stdout: "fake browser tool" });
		}
		if (request.method === "DELETE" && request.url === "/browsers/browser_test") {
			deletedBrowsers.push("browser_test");
			return send({});
		}
		response.writeHead(404);
		response.end(`${request.method} ${request.url}`);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fake server did not bind a port");
	return { url: `http://127.0.0.1:${address.port}`, payloads, deletedBrowsers, close: () => close(server) };
}

function completion(message: unknown, finish_reason: string | null) {
	return {
		id: "fake",
		object: "chat.completion.chunk",
		created: 0,
		model: "gpt-5.6-sol",
		choices: [{ index: 0, delta: message, finish_reason }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
}
function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => resolve(body));
		request.on("error", reject);
	});
}
function close(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function fakeProviderConfig(dir: string, baseUrl: string): Promise<string> {
	const agentDir = join(dir, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				openai: {
					baseUrl,
					apiKey: "test-key",
					api: "openai-completions",
					authHeader: true,
					models: [
						{
							id: "gpt-5.6-sol",
							api: "openai-completions",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				},
			},
		}),
	);
	return agentDir;
}

function parseJsonLines(output: string): Array<Record<string, unknown>> {
	return output
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function runPrint(
	args: string[],
	env: NodeJS.ProcessEnv,
	cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("pi", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`pi print timed out: ${stderr}; output: ${stdout}`));
		}, 15_000);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

async function runRpc(
	args: string[],
	input: string,
	env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("pi", args, { env, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`pi RPC timed out: ${stderr}`));
		}, 15_000);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (stdout.includes('"type":"agent_settled"')) child.stdin.end();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
		child.stdin.write(input);
	});
}

describe("pi modes", () => {
	it("runs a deterministic Loop browser tool in print and RPC modes", async () => {
		const server = await startFakeServer();
		const directory = await mkdtemp(join(tmpdir(), "loop-pi-mode-"));
		try {
			const agentDir = await fakeProviderConfig(directory, server.url);
			const extension = fileURLToPath(new URL("../src/pi-extension/index.ts", import.meta.url));
			const env = {
				...process.env,
				OPENAI_API_KEY: "test-key",
				PI_CODING_AGENT_DIR: agentDir,
				KERNEL_BASE_URL: server.url,
				KERNEL_API_KEY: "test-key",
			};
			const args = ["--extension", extension, "--provider", "openai", "--model", "gpt-5.6-sol", "--browser-tools", "playwright"];

			const print = await runPrint([...args, "-p", "run the browser tool"], env, directory);
			expect(print.code, `${print.stdout}\n${print.stderr}`).toBe(0);
			expect(server.payloads).toHaveLength(2);

			const rpc = await runRpc(["--mode", "rpc", ...args], '{"id":"prompt-1","type":"prompt","message":"run the browser tool"}\n', env);
			expect(rpc.code).toBe(0);
			const events = parseJsonLines(rpc.stdout);
			expect(
				events.some((event) => event.type === "tool_execution_start" && event.toolName === "playwright_execute"),
				rpc.stdout,
			).toBe(true);
			expect(
				events.some((event) => event.type === "tool_execution_end" && event.toolName === "playwright_execute" && event.isError === false),
			).toBe(true);
			expect(events.some((event) => event.type === "agent_settled")).toBe(true);
			expect(server.payloads).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						tools: expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: "playwright_execute" }) })]),
					}),
				]),
			);
			expect(server.deletedBrowsers).toEqual(["browser_test", "browser_test"]);
		} finally {
			await server.close();
			await rm(directory, { recursive: true, force: true });
		}
	}, 30_000);
});
