import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = resolve(__dirname, "../src");
const CORE_DIR = join(SRC_DIR, "core");

/**
 * Bare specifiers core may import. Everything else — pi packages, this
 * package's own entry points (`@onkernel/browser-loop`, `@onkernel/browser-loop/pi`), any
 * future alias — is rejected by default rather than by enumeration.
 */
const ALLOWED_BARE_IMPORTS = [/^node:/, /^typebox(\/|$)/, /^@onkernel\/sdk(\/|$)/, /^sharp(\/|$)/];

/**
 * Statement-anchored so template-literal contents cannot false-positive:
 * import/export-from declarations (single- or multi-line), side-effect
 * imports, dynamic import(), and require().
 */
const IMPORT_SPECIFIERS = [
	/^(?:import|export)\b[^;"'`]*?from\s*["']([^"']+)["']/gm,
	/^import\s*["']([^"']+)["']/gm,
	/(?<![\w$.])(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function coreFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return coreFiles(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

function importsOf(file: string): string[] {
	const source = readFileSync(file, "utf8");
	return IMPORT_SPECIFIERS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]!));
}

function isAllowedCoreImport(specifier: string, file: string): boolean {
	if (specifier.startsWith(".")) return isInsideCore(resolve(dirname(file), specifier));
	return ALLOWED_BARE_IMPORTS.some((allowed) => allowed.test(specifier));
}

function isInsideCore(path: string): boolean {
	const rel = relative(CORE_DIR, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * The neutral boundary: src/core must be expressible without pi in the room.
 * Nothing under it may import a pi package — even type-only — or reach the pi
 * binding through any specifier: relative (`../pi`), the package's own public
 * subpaths (`@onkernel/browser-loop/pi`), or an unlisted bare import.
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
				if (!isAllowedCoreImport(specifier, file)) {
					violations.push(`${relative(SRC_DIR, file)} imports "${specifier}"`);
				}
			}
		}
		expect(violations).toEqual([]);
	});

	it("rejects pi packages, self-package aliases, and escapes from src/core", () => {
		const file = join(CORE_DIR, "tools.ts");
		for (const forbidden of [
			"@earendil-works/pi-ai",
			"@earendil-works/pi-agent-core",
			"@onkernel/browser-loop",
			"@onkernel/browser-loop/pi",
			"../pi/models",
			"../pi-extension/selection",
			"..",
		]) {
			expect(isAllowedCoreImport(forbidden, file), forbidden).toBe(false);
		}
		for (const allowed of ["typebox", "node:fs", "@onkernel/sdk", "@onkernel/sdk/resources/browsers", "./tool-catalog", "./actions/index"]) {
			expect(isAllowedCoreImport(allowed, file), allowed).toBe(true);
		}
	});
});
