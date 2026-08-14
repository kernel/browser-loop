import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureGhosttySource } from "./ensure-ghostty.mjs";

const require = createRequire(import.meta.url);
const config = require("./ghostty-config.cjs");
const localZig = resolve(config.workspaceRoot, ".dev/tools/zig-x86_64-linux-0.15.2/zig");
const requiredVersion = config.upstream.zigVersion;

const ghosttyRoot = await ensureGhosttySource();

const zig = resolveZigBinary();
const version = run([zig, "version"]).trim();
if (version !== requiredVersion) {
	throw new Error(
		`Ghostty requires Zig ${requiredVersion}, but ${zig} reported ${version}. ` +
			`Set PTYWRIGHT_ZIG to a compatible Zig binary or cache one under .dev/tools.`,
	);
}

mkdirSync(config.zigCacheDir, { recursive: true });
mkdirSync(config.zigGlobalCacheDir, { recursive: true });

// Pin the version explicitly: ghostty otherwise derives it from git, and since
// the extracted source has no .git, discovery walks up into the host repo and
// panics when HEAD is on a non-vX.Y.Z tag (e.g. a package release tag).
run([
	zig,
	"build",
	"-Demit-lib-vt=true",
	`-Dversion-string=${config.upstream.version}`,
	"--cache-dir",
	config.zigCacheDir,
	"--global-cache-dir",
	config.zigGlobalCacheDir,
], {
	cwd: ghosttyRoot,
});

function resolveZigBinary() {
	if (process.env.PTYWRIGHT_ZIG) {
		return process.env.PTYWRIGHT_ZIG;
	}
	if (process.platform === "linux" && process.arch === "x64" && existsSync(localZig)) {
		return localZig;
	}
	return "zig";
}

function run(command, options = {}) {
	const result = spawnSync(command[0], command.slice(1), {
		stdio: "pipe",
		encoding: "utf8",
		...options,
	});
	if (result.status !== 0) {
		throw new Error(
			[
				`Command failed: ${command.join(" ")}`,
				result.stdout?.trim(),
				result.stderr?.trim(),
			]
				.filter(Boolean)
				.join("\n"),
		);
	}
	return result.stdout ?? "";
}
