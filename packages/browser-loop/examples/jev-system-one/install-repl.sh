#!/usr/bin/env bash
set -euo pipefail

repo="kernel/browser-loop"
ref="${BROWSER_LOOP_REF:-main}"
install_dir="${BROWSER_LOOP_REPL_INSTALL_DIR:-/tmp/browser-loop}"
source_dir="${BROWSER_LOOP_SOURCE_DIR:-}"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

for command in curl tar node npm; do
	if ! command -v "$command" >/dev/null 2>&1; then
		echo "missing required command: $command" >&2
		exit 1
	fi
done

checkout="$work_dir/repo"
mkdir -p "$checkout"
if [[ -n "$source_dir" ]]; then
	cp -a "$source_dir/". "$checkout/"
else
	curl -fsSL "https://github.com/$repo/archive/$ref.tar.gz" \
		| tar -xz --strip-components=1 -C "$checkout"
fi

(
	cd "$checkout"
	npm ci --ignore-scripts --silent
)

example="$checkout/packages/browser-loop/examples/jev-system-one"
(
	cd "$example"
	npm ci --ignore-scripts --silent
)

mkdir -p "$install_dir"
output="$install_dir/.jev-agent.mjs.$$"
"$checkout/node_modules/.bin/esbuild" "$example/repl.ts" \
	--bundle \
	--platform=node \
	--format=esm \
	--outfile="$output" \
	--log-level=warning
mv "$output" "$install_dir/jev-agent.mjs"
printf '%s\n' "$install_dir/jev-agent.mjs"
