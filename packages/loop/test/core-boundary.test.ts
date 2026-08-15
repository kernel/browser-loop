import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = resolve(__dirname, "../src");
const CORE_DIR = join(SRC_DIR, "core");

/** import/export ... from "x", side-effect import "x", dynamic import("x"), require("x"). */
const IMPORT_SPECIFIERS = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

function coreFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return coreFiles(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

function importsOf(file: string): string[] {
	const source = readFileSync(file, "utf8");
	return [...source.matchAll(IMPORT_SPECIFIERS)].map((match) => match[1]!);
}

/**
 * The neutral boundary: src/core must be expressible without pi in the room.
 * Nothing under it may import a pi package — even type-only — or reach into
 * the pi binding (src/pi) or the pi extension.
 */
describe("core boundary", () => {
	const files = coreFiles(CORE_DIR);

	it("walks a non-empty core tree", () => {
		expect(files.length).toBeGreaterThan(10);
	});

	it("imports nothing from pi, at runtime or in types", () => {
		const violations: string[] = [];
		for (const file of files) {
			for (const specifier of importsOf(file)) {
				const violation = specifier.startsWith("@earendil-works/")
					|| (specifier.startsWith(".") && !isInsideCore(resolve(dirname(file), specifier)));
				if (violation) violations.push(`${relative(SRC_DIR, file)} imports "${specifier}"`);
			}
		}
		expect(violations).toEqual([]);
	});
});

function isInsideCore(path: string): boolean {
	return !relative(CORE_DIR, path).startsWith(`..${sep}`);
}
