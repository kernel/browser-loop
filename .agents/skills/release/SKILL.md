---
name: release
description: Prepare and publish the @onkernel/browser-loop npm release from kernel/browser-loop. Use when checking release readiness, choosing a package version, writing the package changelog, committing release metadata to main, pushing package-prefixed tags, or monitoring the release workflow.
---

# Release

Use this workflow to release `@onkernel/browser-loop`.

The first publish under the `@onkernel/browser-loop` name is manual, because npm binds a
trusted publisher to a (repository, workflow filename) pair and a brand-new
package name has none. See `docs/npm-releases.md`.

If a release run hits an unexpected bump, unclear decision, missing command, or
avoidable manual step, update this skill as part of the release cleanup. Keep
the note concise and operational so the next release is faster and less
error-prone.

## Package Map

| package | directory | tag prefix | workflow |
| --- | --- | --- | --- |
| `@onkernel/browser-loop` | `packages/browser-loop` | `browser-loop/v` | `release-browser-loop.yml` |
| `@onkernel/ptywright` | `packages/ptywright` | — | not published |

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
npm view @onkernel/browser-loop versions --json
test -f .github/workflows/release-browser-loop.yml
```

3. Find the previous release tag:

```bash
git tag --list "browser-loop/v*" --sort=-v:refname | head -1
```

If no tag exists, treat the next release as the current `package.json` version
unless npm already has that version.

4. Inspect changes since the last tag:

```bash
git log --oneline <last-tag>..HEAD -- packages/browser-loop package.json package-lock.json tsconfig.base.json
git diff --name-status <last-tag>..HEAD -- packages/browser-loop package.json package-lock.json tsconfig.base.json
```

## Version Choice

Choose a version from source changes, existing npm versions, and the previous
tag:

- No consumer-relevant changes: do not release.
- Bug fixes, docs that affect consumers, dependency metadata, or small behavior
  fixes: patch.
- New exported APIs, new model/provider support, new examples intended for
  consumers, or materially expanded behavior: minor.
- Breaking API or behavior changes: major. While the package is `0.x`, use a
  minor bump for breaking changes unless it is intentionally moving to `1.0.0`.

The candidate version must be greater than both the last tag and every version
returned by `npm view @onkernel/browser-loop versions --json`.

## Changelog

Changes land under a `## Unreleased` heading in `packages/browser-loop/CHANGELOG.md` as
they merge, so the changelog has at most one unreleased section.

Releasing renames that heading in place — do not add a second top entry:

```markdown
## <version> - YYYY-MM-DD
```

Then read the section as a whole before tagging. It accumulated over several
merges, so it can carry entries that contradict each other or describe a state
that never shipped: an API added and then removed, or a note that a provider
"keeps" a behavior when a later entry deletes that provider. Consumers upgrade
from the previous release, not through the intermediate steps, so collapse
those into the net change and drop what nobody can observe.

Write customer-facing changes. Do not dump commit subjects, internal issue
names, or vague entries like "misc improvements." Group details only when it
improves readability. If the release is only metadata or docs, say that plainly.

Merges between releases add to `## Unreleased`, creating it directly under
`# Changelog` when it is absent. Never invent a version heading for a merge:
the version is chosen at release time from the accumulated changes, and a
per-merge heading claims a release that never happened.

## Edit Release Metadata

Set the version explicitly:

```bash
npm pkg set version=<version> --workspace @onkernel/browser-loop
```

Refresh the lockfile:

```bash
npm install --package-lock-only
```

If a version-only bump causes npm to reorder or rewrite unrelated platform
packages, restore the lockfile and update only the workspace's `version` entry.
Do not commit thousands of lines of lockfile churn; `npm ci` and
`npm run check:lockfile` must still pass.

## Validate

```bash
npm ci
npm run build --workspace @onkernel/browser-loop
npm run typecheck
npm test --workspace @onkernel/browser-loop
npm pack --workspace @onkernel/browser-loop --dry-run
```

Build before testing: the pi print/RPC test loads the extension the way pi does,
through the package's own entry points. Run the full unit suite — do not pass
individual test files. Integration tests run separately (`npm run
test:integration --workspace @onkernel/browser-loop`), and live e2e tests skip unless
`LOOP_E2E_LIVE=1` is set.

Confirm the packed tarball ships `dist` and the extension source pi loads
through jiti, since `pi.extensions` points at `./src/pi-extension/index.ts`.

Do not push a release tag if build, tests, or the pack dry-run fail.

## Commit To Main

Direct commits to `main` are acceptable for release metadata. Keep the commit
limited to the package version, changelog, and `package-lock.json`.

```bash
git status --short
git add package-lock.json packages/browser-loop/package.json packages/browser-loop/CHANGELOG.md
git commit -m "Release @onkernel/browser-loop v<version>"
git push origin main
```

## Tag And Push

After the release commit is on `main`, create an annotated tag at that commit:

```bash
git tag -a browser-loop/v<version> -m "@onkernel/browser-loop v<version>"
git push origin browser-loop/v<version>
```

## Monitor

Find and watch the workflow run triggered by the tag:

```bash
gh run list --workflow release-browser-loop.yml --json databaseId,status,conclusion,headBranch,displayTitle,url --limit 10
gh run watch <run-id> --exit-status
```

After the workflow succeeds, verify npm:

```bash
npm view @onkernel/browser-loop@<version> version
npm dist-tag ls @onkernel/browser-loop
```

Then verify the published artifact actually imports — `npm view` only proves
the version exists, not that the tarball is loadable:

```bash
cd "$(mktemp -d)"
npm init -y
npm install @onkernel/browser-loop@<version>
node --input-type=module -e "import('@onkernel/browser-loop').then((m) => { if (typeof m.compileLoopToolCatalog !== 'function') process.exit(1); })"
node --input-type=module -e "import('@onkernel/browser-loop/pi').then((m) => { if (typeof m.attach !== 'function') process.exit(1); })"
```

If the workflow fails after a tag is pushed, do not reuse the same version
unless npm did not publish it. Fix forward with a new commit and a new patch
version when a version has reached npm.
