# npm releases

`@onkernel/cua-ai`, `@onkernel/cua-agent`, `@onkernel/cua-cli`, and
`@onkernel/cua-pi-extension` publish from package-specific tags:

- `cua-ai/v0.1.0` runs `.github/workflows/release-cua-ai.yml`
- `cua-agent/v0.1.0` runs `.github/workflows/release-cua-agent.yml`
- `cua-cli/v0.1.0` runs `.github/workflows/release-cua-cli.yml`
- `cua-pi-extension/v0.10.1` runs `.github/workflows/release-cua-pi-extension.yml`

The tag version must match the target package's `package.json` version, and the
tagged commit must be contained in `main`.

## Trusted publishing setup

Configure each package on npm with a GitHub Actions trusted publisher:

| package | organization | repository | workflow filename | environment |
| --- | --- | --- | --- | --- |
| `@onkernel/cua-ai` | `kernel` | `cua` | `release-cua-ai.yml` | leave blank |
| `@onkernel/cua-agent` | `kernel` | `cua` | `release-cua-agent.yml` | leave blank |
| `@onkernel/cua-cli` | `kernel` | `cua` | `release-cua-cli.yml` | leave blank |
| `@onkernel/cua-pi-extension` | `kernel` | `cua` | `release-cua-pi-extension.yml` | leave blank |

The same configuration can be created from the npm CLI:

```sh
npm install -g npm@^11.17.0
npm trust github @onkernel/cua-ai --repo kernel/cua --file release-cua-ai.yml --allow-publish
npm trust github @onkernel/cua-agent --repo kernel/cua --file release-cua-agent.yml --allow-publish
npm trust github @onkernel/cua-cli --repo kernel/cua --file release-cua-cli.yml --allow-publish
npm trust github @onkernel/cua-pi-extension --repo kernel/cua --file release-cua-pi-extension.yml --allow-publish
```

npm requires packages to exist before a trusted publisher can be configured. If
the package has not been published yet, either publish the first version manually
and use trusted publishing for later versions, or publish a bootstrap version
first, configure trusted publishing, then release `0.1.0` from tags.

## Releasing 0.1.0

Publish `@onkernel/cua-ai` first because `@onkernel/cua-agent` depends on it:

```sh
git checkout main
git pull --ff-only
git tag cua-ai/v0.1.0
git push origin cua-ai/v0.1.0
```

After `@onkernel/cua-ai@0.1.0` is available on npm:

```sh
git tag cua-agent/v0.1.0
git push origin cua-agent/v0.1.0
```

## Releasing `@onkernel/cua-cli` 0.1.0

`@onkernel/cua-cli` has not been published yet. npm requires a package to exist
before a trusted publisher can be configured for it, so the first release is a
manual publish from a local checkout. Subsequent releases come from
`cua-cli/v*` tags via `.github/workflows/release-cua-cli.yml`.

The CLI's runtime dependencies, including `@onkernel/cua-ai`,
`@onkernel/cua-agent`, `@onkernel/sdk`, `@earendil-works/pi-coding-agent`,
and `@earendil-works/pi-tui`, must already be on npm at the pinned versions
before publishing; verify with `npm view @onkernel/cua-ai@<version>` etc. if
unsure.

First-publish steps (run from a maintainer machine with an npm account in the
`onkernel` org and Zig available on `PATH` for the ptywright dev build):

```sh
# 1. Fresh checkout of main
git clone https://github.com/kernel/cua.git
cd cua
git checkout main
git pull --ff-only

# 2. Install and build the workspace (Node >= 22.19)
npm ci
npm run build

# 3. Run cua-cli unit tests with the native ptywright binding required
PTYWRIGHT_REQUIRED=1 npm test --workspace @onkernel/cua-cli

# 4. Pre-publish smoke test: pack the tarball, install it into a fresh temp
#    project, and run the installed `cua` bin. Do NOT proceed to step 5 until
#    this passes — published npm versions are immutable, and the tag-driven
#    workflow runs this same check on subsequent releases.
PACK_DIR=$(mktemp -d)
npm pack --workspace @onkernel/cua-cli --pack-destination "$PACK_DIR"
SMOKE_DIR=$(mktemp -d)
(cd "$SMOKE_DIR" && npm init -y > /dev/null && \
  npm install "$PACK_DIR"/onkernel-cua-cli-*.tgz && \
  ./node_modules/.bin/cua --help)

# 5. Log in to npm as a user in the onkernel org, then publish
npm login
npm publish --workspace @onkernel/cua-cli --access public
```

After `@onkernel/cua-cli@0.1.0` is on the registry, configure the trusted
publisher — either via the package page in the npm web UI (Settings →
Publishing access → Add trusted publisher) using the row from the
[trusted publishing setup](#trusted-publishing-setup) table, or from the CLI:

```sh
npm install -g npm@^11.17.0
npm trust github @onkernel/cua-cli --repo kernel/cua --file release-cua-cli.yml --allow-publish
```

From `0.1.1` onward, bump `packages/cli/package.json` on `main`, then tag and
push:

```sh
git tag cua-cli/v0.1.1
git push origin cua-cli/v0.1.1
```
