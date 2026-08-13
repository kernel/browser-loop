import { defineConfig } from "vitest/config";

export default defineConfig({
	server: {
		host: "127.0.0.1",
	},
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		// pi-ai ships real ESM and imports "openai" itself; both need to run
		// through Vitest's module graph (not Node's native loader) for
		// vi.mock("openai") to intercept requests pi's builtin transport makes.
		server: { deps: { inline: [/@earendil-works\/pi-ai/, /^openai$/] } },
	},
});
