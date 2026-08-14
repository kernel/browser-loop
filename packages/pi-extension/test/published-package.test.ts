import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("published pi package", () => {
	it("ships a discoverable TypeScript extension manifest and runtime dependencies", async () => {
		const pkg = JSON.parse(await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"));
		expect(pkg.pi.extensions).toEqual(["./src/index.ts"]);
		expect(pkg.files).toContain("src");
		expect(pkg.dependencies).toMatchObject({
			"@onkernel/cua-ai": pkg.version,
			"@onkernel/cua-agent": pkg.version,
			"@onkernel/sdk": expect.any(String),
		});
		expect(pkg.peerDependencies.typebox).toBeUndefined();
	});
});
