#!/usr/bin/env bash
set -euo pipefail

repo="kernel/browser-loop"
ref="${BROWSER_LOOP_REF:-main}"
install_dir="${BROWSER_LOOP_REPL_INSTALL_DIR:-/tmp/browser-loop}"
base_url="https://raw.githubusercontent.com/$repo/$ref/packages/browser-loop/examples/jev-system-one"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

for command in curl sha256sum; do
	if ! command -v "$command" >/dev/null 2>&1; then
		echo "missing required command: $command" >&2
		exit 1
	fi
done

bundle="$work_dir/jev-agent.mjs"
checksum="$work_dir/jev-agent.mjs.sha256"
curl -fsSL "$base_url/jev-agent.mjs" -o "$bundle"
curl -fsSL "$base_url/jev-agent.mjs.sha256" -o "$checksum"
(
	cd "$work_dir"
	sha256sum --check --status jev-agent.mjs.sha256
)

mkdir -p "$install_dir"
mv "$bundle" "$install_dir/jev-agent.mjs"
printf '%s\n' "$install_dir/jev-agent.mjs"
