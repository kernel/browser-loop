import { describe, expect, it } from "vitest";
import { compileLoopToolCatalog, loop } from "../src/index";

const model = { provider: "test", id: "test-model", api: "test" };

describe("Browser REPL tool", () => {
	it("has one stable identity and the POST /repl input contract", () => {
		const tool = loop.tools.repl();
		expect(tool.identity).toBe("kloop.repl.v1");
		expect(tool.name).toBe("browser_repl");
		expect(tool.execution).toEqual({ kind: "repl" });
		expect(tool.declaration.parameters).toMatchObject({
			type: "object",
			required: ["code"],
			additionalProperties: false,
			properties: {
				code: { type: "string" },
				timeout_sec: { type: "integer", minimum: 1, maximum: 300, default: 60 },
				reset: { type: "boolean" },
			},
		});
	});

	it("compiles as an ordinary framework-neutral function tool", () => {
		const catalog = compileLoopToolCatalog({ model, requestedTools: [loop.tools.repl()] });
		expect(catalog.entries).toMatchObject([{ identity: "kloop.repl.v1", name: "browser_repl", transport: "function" }]);
	});
});
