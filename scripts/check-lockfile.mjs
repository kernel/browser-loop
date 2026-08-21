import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const packages = lock.packages ?? {};
const missing = [];

function resolutionPaths(packagePath, dependency) {
	const paths = [`${packagePath}/node_modules/${dependency}`];
	let cursor = packagePath;
	while (true) {
		const nested = cursor.lastIndexOf("/node_modules/");
		if (nested === -1) break;
		paths.push(`${cursor.slice(0, nested)}/node_modules/${dependency}`);
		cursor = cursor.slice(0, nested);
	}
	paths.push(`node_modules/${dependency}`);
	return paths;
}

for (const [packagePath, metadata] of Object.entries(packages)) {
	for (const section of ["dependencies", "optionalDependencies"]) {
		for (const dependency of Object.keys(metadata[section] ?? {})) {
			if (!resolutionPaths(packagePath, dependency).some((candidate) => packages[candidate])) {
				missing.push(`${packagePath || "."} -> ${dependency}`);
			}
		}
	}
}

if (missing.length > 0) {
	throw new Error(`package-lock.json omits dependencies:\n${missing.join("\n")}`);
}

console.log("package-lock.json includes all dependency entries");
