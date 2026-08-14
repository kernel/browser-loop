import { defineConfig } from "vitest/config";

export default defineConfig({
	// This environment does not resolve "localhost".
	server: {
		host: "127.0.0.1",
	},
	test: {
		globals: true,
		environment: "node",
		// The pi print/RPC test spawns a real pi process and waits on a fake
		// provider, which is slower than a unit test but still bounded.
		testTimeout: 30000,
	},
});
