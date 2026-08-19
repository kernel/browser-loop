import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("published pi package", () => {
	it("ships a discoverable TypeScript extension manifest and runtime dependencies", async () => {
		const pkg = JSON.parse(await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"));
		expect(pkg.pi.extensions).toEqual(["./src/pi-extension/index.ts"]);
		// pi reads the extension's TypeScript directly, so the tarball ships src alongside dist.
		expect(pkg.files).toContain("src");
		expect(pkg.dependencies).toMatchObject({
			"@earendil-works/pi-agent-core": expect.any(String),
			"@earendil-works/pi-ai": expect.any(String),
			"@onkernel/sdk": expect.any(String),
		});
		expect(pkg.peerDependencies.typebox).toBeUndefined();
	});
});
