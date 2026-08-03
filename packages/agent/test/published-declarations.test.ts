import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const agentRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(agentRoot, "..", "..");

/**
 * Downstream consumer compiled against the packaged declarations (dist/) with
 * skipLibCheck disabled, so transitive declaration issues in cua-agent,
 * cua-ai, pi, or TypeBox surface here instead of after publish.
 */
const CONSUMER = `
import { Type } from "typebox";
import {
	CuaAgent,
	CuaAgentHarness,
	InMemorySessionRepo,
	NodeExecutionEnv,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type AgentHarnessTool,
	type CuaAgentTool,
	type CuaHarnessTool,
	type ExecutionToolContext,
	type KernelBrowser,
} from "@onkernel/cua-agent";
import { cua, getCuaModel } from "@onkernel/cua-ai";
import type Kernel from "@onkernel/sdk";

declare const browser: KernelBrowser;
declare const client: Kernel;

const toolContext: ExecutionToolContext = { env: new NodeExecutionEnv({ cwd: process.cwd() }) };

const custom: AgentHarnessTool<ExecutionToolContext> = {
	name: "custom",
	label: "custom",
	description: "custom tool",
	parameters: Type.Object({}),
	execute: async (_toolCallId, _params, _signal, _onUpdate, context) => {
		const delivered: ExecutionToolContext = context;
		void delivered;
		return { content: [{ type: "text", text: "ok" }], details: undefined };
	},
};

const harnessTools: readonly CuaHarnessTool<ExecutionToolContext>[] = [
	...cua.toolsets.browser(),
	createReadTool(),
	createBashTool(),
	createEditTool(),
	createWriteTool(),
	custom,
];

const agentTools: readonly CuaAgentTool[] = [...cua.toolsets.browser()];

async function build() {
	const session = await new InMemorySessionRepo().create();
	const harness = new CuaAgentHarness<ExecutionToolContext>({
		browser,
		client,
		session,
		model: "openai:gpt-5.6-sol",
		tools: harnessTools,
		toolContext,
	});
	const contextFree = new CuaAgentHarness({
		browser,
		client,
		session,
		model: getCuaModel("openai:gpt-5.6-sol"),
		tools: [],
	});
	new CuaAgentHarness({
		browser,
		client,
		session,
		model: "openai:gpt-5.6-sol",
		tools: [],
		// @ts-expect-error env was removed; the tool context now carries the execution env
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
	});
	const agent = new CuaAgent({ browser, client, tools: agentTools, initialState: { model: "openai:gpt-5.6-sol" } });
	return { harness, contextFree, agent };
}

void build;
`;

function run(command: string, args: string[], cwd: string): void {
	try {
		execFileSync(command, args, { cwd, stdio: "pipe" });
	} catch (error) {
		const failure = error as { stdout?: Buffer; stderr?: Buffer };
		throw new Error(
			`${command} ${args.join(" ")} failed:\n${failure.stdout?.toString() ?? ""}${failure.stderr?.toString() ?? ""}`,
			{ cause: error },
		);
	}
}

// skipLibCheck: false checks the whole reachable declaration graph. Two
// vendored SDK typings cannot compile under it in a hoisted node_modules
// layout, independent of cua: @anthropic-ai/sdk unions import() fallbacks
// for nested layouts that cannot resolve, and @google/genai references an
// optional MCP package and DOM event globals. Tolerate exactly those two
// files' errors; anything else — above all our dist declarations, pi's, or
// TypeBox's — fails the test.
const TOLERATED = [
	/node_modules\/\@anthropic-ai\/sdk\/.*TS2307/,
	/node_modules\/\@google\/genai\/.*TS(2307|2304|2552)/,
];

function runTsc(tsconfigDir: string): void {
	try {
		execFileSync(process.execPath, [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", tsconfigDir], { stdio: "pipe" });
		return;
	} catch (error) {
		const failure = error as { stdout?: Buffer; stderr?: Buffer };
		const output = `${failure.stdout?.toString() ?? ""}${failure.stderr?.toString() ?? ""}`;
		const errors = output.trim().split("\n").filter((line) => line.length > 0);
		const unexpected = errors.filter((line) => !TOLERATED.some((pattern) => pattern.test(line)));
		if (unexpected.length === 0) return;
		throw new Error(`tsc reported unexpected declaration errors:\n${unexpected.join("\n")}`, { cause: error });
	}
}

describe("published declarations", () => {
	it("compile a downstream consumer with skipLibCheck: false", { timeout: 300_000 }, () => {
		run("npm", ["run", "build", "--workspace", "@onkernel/cua-ai"], repoRoot);
		run("npm", ["run", "build", "--workspace", "@onkernel/cua-agent"], repoRoot);

		const dir = mkdtempSync(join(tmpdir(), "cua-declarations-"));
		writeFileSync(join(dir, "consumer.ts"), CONSUMER);
		writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "Bundler",
				lib: ["ES2022"],
				types: ["node"],
				typeRoots: [join(repoRoot, "node_modules", "@types")],
				strict: true,
				skipLibCheck: false,
				noEmit: true,
				baseUrl: repoRoot,
				paths: {
					"@onkernel/cua-ai": ["packages/ai/dist/index.d.ts"],
					"@onkernel/cua-agent": ["packages/agent/dist/index.d.ts"],
					"*": ["./node_modules/*"],
				},
			},
			include: ["consumer.ts"],
		}, null, 2));

		runTsc(dir);
	});
});
