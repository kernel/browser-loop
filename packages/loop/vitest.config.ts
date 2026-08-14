import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	server: {
		host: "127.0.0.1",
	},
	resolve: {
		// The pi extension imports this package by name, because pi loads it as
		// TypeScript through jiti and jiti's pi-ai alias cannot follow the deep
		// `@earendil-works/pi-ai/api/*` imports the provider adapters make. Unit
		// tests point that name back at source so they do not need a build.
		alias: {
			"@onkernel/loop/pi": fileURLToPath(new URL("./src/pi/index.ts", import.meta.url)),
			"@onkernel/loop": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
		},
	},
	test: {
		globals: true,
		environment: "node",
		// The pi print/RPC test spawns a real pi process and waits on a fake
		// provider, which is slower than a unit test but still bounded.
		testTimeout: 30000,
		// Unit runs cover every test file except the opt-in suites; use
		// vitest.integration.config.ts to run those.
		exclude: [...configDefaults.exclude, "**/*.integration.test.ts", "**/*.live.test.ts"],
		// pi-ai ships real ESM and imports "openai" itself; both need to run
		// through Vitest's module graph (not Node's native loader) for
		// vi.mock("openai") to intercept requests pi's builtin transport makes.
		server: { deps: { inline: [/@earendil-works\/pi-ai/, /^openai$/] } },
	},
});
