---
name: release
description: Prepare and publish @onkernel/cua-ai, @onkernel/cua-agent, and @onkernel/cua-cli npm releases from kernel/cua. Use when checking release readiness, choosing package versions, writing package changelogs, committing release metadata to main, pushing package-prefixed tags, or monitoring release workflows.
---

# Release

Use this workflow to release `@onkernel/cua-ai`, `@onkernel/cua-agent`, and
`@onkernel/cua-cli`. The packages do not need to release in lockstep.

If a release run hits an unexpected bump, unclear decision, missing command, or
avoidable manual step, update this skill as part of the release cleanup. Keep
the note concise and operational so the next release is faster and less
error-prone.

## Package Map

| package | directory | tag prefix | workflow |
| --- | --- | --- | --- |
| `@onkernel/cua-ai` | `packages/ai` | `cua-ai/v` | `release-cua-ai.yml` |
| `@onkernel/cua-agent` | `packages/agent` | `cua-agent/v` | `release-cua-agent.yml` |
| `@onkernel/cua-cli` | `packages/cli` | `cua-cli/v` | `release-cua-cli.yml` |

When all three change, release in dependency order: `cua-ai`, then `cua-agent`,
then `cua-cli`. The CLI production workflow verifies that its exact AI and agent
dependency versions already exist on npm.

## Quick Start

1. Sync `main` and tags:

```bash
git switch main
git pull --ff-only origin main
git fetch --tags origin
```

2. Check release readiness:

```bash
git status --short
npm view @onkernel/cua-ai versions --json
npm view @onkernel/cua-agent versions --json
npm view @onkernel/cua-cli versions --json
test -f .github/workflows/release-cua-ai.yml
test -f .github/workflows/release-cua-agent.yml
test -f .github/workflows/release-cua-cli.yml
```

3. For each package, find the previous release tag:

```bash
git tag --list "cua-ai/v*" --sort=-v:refname | head -1
git tag --list "cua-agent/v*" --sort=-v:refname | head -1
git tag --list "cua-cli/v*" --sort=-v:refname | head -1
```

If no tag exists, treat the next release as the package's current
`package.json` version unless npm already has that version.

4. Inspect package-specific changes since the last tag:

```bash
git log --oneline <last-tag>..HEAD -- packages/ai package.json package-lock.json tsconfig.base.json
git diff --name-status <last-tag>..HEAD -- packages/ai package.json package-lock.json tsconfig.base.json

git log --oneline <last-tag>..HEAD -- packages/agent packages/ai package.json package-lock.json tsconfig.base.json
git diff --name-status <last-tag>..HEAD -- packages/agent packages/ai package.json package-lock.json tsconfig.base.json

git log --oneline <last-tag>..HEAD -- packages/cli packages/agent packages/ai package.json package-lock.json tsconfig.base.json
git diff --name-status <last-tag>..HEAD -- packages/cli packages/agent packages/ai package.json package-lock.json tsconfig.base.json
```

For a dependent package, include upstream package changes only when they affect
its published dependency version or runtime behavior.

## Version Choice

Choose a version per package from source changes, existing npm versions, and the
previous tag:

- No package-relevant changes: do not release that package.
- Bug fixes, docs that affect package consumers, dependency metadata, or small
  behavior fixes: patch.
- New exported APIs, new model/provider support, new examples intended for
  consumers, or materially expanded behavior: minor.
- Breaking API or behavior changes: major. While packages are `0.x`, use a
  minor bump for breaking changes unless the package is intentionally moving to
  `1.0.0`.

The candidate version must be greater than both the last tag for that package
and every version returned by `npm view <package> versions --json`.

## Changelog

Changes land under a `## Unreleased` heading as they merge, so every changelog
has at most one unreleased section:

- `packages/ai/CHANGELOG.md`
- `packages/agent/CHANGELOG.md`
- `packages/cli/CHANGELOG.md`

Releasing renames that heading in place — do not add a second top entry:

```markdown
## <version> - YYYY-MM-DD
```

Then read the section as a whole before tagging. It accumulated over several
merges, so it can carry entries that contradict each other or describe a state
that never shipped: an API added and then removed, or a note that a provider
"keeps" a behavior when a later entry deletes that provider. Consumers upgrade
from the previous release, not through the intermediate steps, so collapse
those into the net change and drop what nobody can observe. Cross-package
"update `@onkernel/cua-ai` to X" notes belong here too — the version is not
known until this step.

Write customer-facing changes. Do not dump commit subjects, internal issue
names, Slack context, or vague entries like "misc improvements." Group details
only when it improves readability. If the release is only metadata or docs,
say that plainly.

Merges between releases add to `## Unreleased`, creating it directly under
`# Changelog` when it is absent. Never invent a version heading for a merge:
package versions are chosen at release time from the accumulated changes, and a
per-merge heading claims a release that never happened.

## Edit Release Metadata

Set versions explicitly:

```bash
npm pkg set version=<version> --workspace @onkernel/cua-ai
npm pkg set version=<version> --workspace @onkernel/cua-agent
npm pkg set version=<version> --workspace @onkernel/cua-cli
```

Ensure exact internal dependencies point at the versions that will be published
first: agent to AI, and CLI to both AI and agent. Edit the package manifests
directly if `npm pkg set` is awkward for scoped dependency keys.

Refresh the lockfile:

```bash
npm install --package-lock-only
```

## Validate

Run the checks for each package being released:

```bash
npm ci
npm run build --workspace @onkernel/cua-ai
npm test --workspace @onkernel/cua-ai
npm pack --workspace @onkernel/cua-ai --dry-run
```

For `@onkernel/cua-agent`:

```bash
npm run build --workspace @onkernel/cua-ai
npm run build --workspace @onkernel/cua-agent
npm test --workspace @onkernel/cua-agent
npm pack --workspace @onkernel/cua-agent --dry-run
```

For `@onkernel/cua-cli`:

```bash
npm run build --workspace @onkernel/cua-ai
npm run build --workspace @onkernel/cua-agent
npm run build --workspace @onkernel/ptywright
npm run build --workspace @onkernel/cua-cli
PTYWRIGHT_REQUIRED=1 npm test --workspace @onkernel/cua-cli
npm pack --workspace @onkernel/cua-cli --dry-run
```

Run the full unit suites — do not pass individual test files. `cua-ai`
excludes integration/live tests by default (`npm run test:integration
--workspace @onkernel/cua-ai` runs them separately), and the `cua-agent` live
e2e tests skip unless `CUA_E2E_LIVE=1` is set.

Do not push release tags if build, tests, or pack dry-runs fail.

## Commit To Main

Direct commits to `main` are acceptable for release metadata. Keep the commit
limited to package versions, changelogs, and `package-lock.json`.

```bash
git status --short
git add package-lock.json packages/ai/package.json packages/ai/CHANGELOG.md packages/agent/package.json packages/agent/CHANGELOG.md packages/cli/package.json packages/cli/CHANGELOG.md
git commit -m "Release CUA packages"
git push origin main
```

Use a package-specific commit message if releasing only one package, for
example `Release CUA AI v0.2.0`.

## Tag And Push

After the release commit is on `main`, create annotated package tags at that
commit:

```bash
git tag -a cua-ai/v<version> -m "@onkernel/cua-ai v<version>"
git push origin cua-ai/v<version>
```

For the agent package:

```bash
git tag -a cua-agent/v<version> -m "@onkernel/cua-agent v<version>"
git push origin cua-agent/v<version>

git tag -a cua-cli/v<version> -m "@onkernel/cua-cli v<version>"
git push origin cua-cli/v<version>
```

Push and verify each dependency tag before the next one: AI, then agent, then
CLI.

## Monitor

Find and watch the workflow run triggered by each tag:

```bash
gh run list --workflow release-cua-ai.yml --json databaseId,status,conclusion,headBranch,displayTitle,url --limit 10
gh run watch <run-id> --exit-status

gh run list --workflow release-cua-agent.yml --json databaseId,status,conclusion,headBranch,displayTitle,url --limit 10
gh run watch <run-id> --exit-status

gh run list --workflow release-cua-cli.yml --json databaseId,status,conclusion,headBranch,displayTitle,url --limit 10
gh run watch <run-id> --exit-status
```

After a workflow succeeds, verify npm:

```bash
npm view @onkernel/cua-ai@<version> version
npm dist-tag ls @onkernel/cua-ai
npm view @onkernel/cua-agent@<version> version
npm dist-tag ls @onkernel/cua-agent
npm view @onkernel/cua-cli@<version> version
npm dist-tag ls @onkernel/cua-cli
```

Then verify the published artifact actually imports — `npm view` only proves
the version exists, not that the tarball is loadable:

```bash
cd "$(mktemp -d)"
npm init -y
npm install @onkernel/cua-ai@<version>
node --input-type=module -e "import('@onkernel/cua-ai').then((m) => { if (typeof m.getCuaModel !== 'function') process.exit(1); })"
```

For `@onkernel/cua-agent`, install `@onkernel/cua-agent@<version>` the same
way and check `typeof m.attach === "function"`. For the CLI, install it in a
fresh directory and verify `./node_modules/.bin/cua --help` prints `Usage:`.

If a workflow fails after a tag is pushed, do not reuse the same package
version unless npm did not publish it. Fix forward with a new commit and a new
patch version when a package version has reached npm.
