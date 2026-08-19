import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	server: {
		host: "127.0.0.1",
	},
	resolve: {
		// Same source alias the unit config sets; see the note there.
		alias: {
			"@onkernel/browser-loop/pi": fileURLToPath(new URL("./src/pi/index.ts", import.meta.url)),
			"@onkernel/browser-loop": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
		},
	},
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		include: ["test/**/*.integration.test.ts", "test/**/*.live.test.ts"],
	},
});
