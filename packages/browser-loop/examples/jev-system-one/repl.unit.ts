import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJevAgent } from "./repl";

describe("Jev REPL agent", () => {
	it("requires the browser REPL CDP endpoint", () => {
		const previous = process.env.CDP_ENDPOINT;
		delete process.env.CDP_ENDPOINT;
		try {
			assert.throws(() => createJevAgent(), /CDP_ENDPOINT is required/);
		} finally {
			if (previous === undefined) delete process.env.CDP_ENDPOINT;
			else process.env.CDP_ENDPOINT = previous;
		}
	});

	it("creates a closeable agent around the current browser", () => {
		const previousCdp = process.env.CDP_ENDPOINT;
		const previousTypeSafe = process.env.TYPESAFE_API_KEY;
		process.env.CDP_ENDPOINT = "ws://127.0.0.1:1";
		process.env.TYPESAFE_API_KEY = "test-key";
		try {
			const agent = createJevAgent({ maxSteps: 3 });
			assert.equal(typeof agent, "function");
			assert.equal(typeof agent.close, "function");
			agent.close();
		} finally {
			if (previousCdp === undefined) delete process.env.CDP_ENDPOINT;
			else process.env.CDP_ENDPOINT = previousCdp;
			if (previousTypeSafe === undefined) delete process.env.TYPESAFE_API_KEY;
			else process.env.TYPESAFE_API_KEY = previousTypeSafe;
		}
	});
});
