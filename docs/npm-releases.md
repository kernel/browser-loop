# npm releases

`@onkernel/cua-ai` and `@onkernel/cua-agent` publish from package-specific tags:

- `cua-ai/v0.1.0` runs `.github/workflows/release-cua-ai.yml`
- `cua-agent/v0.1.0` runs `.github/workflows/release-cua-agent.yml`

`@onkernel/cua-pi-extension` has no workflow yet. It merges into the renamed
single package, and a first publish under a new name is manual either way — see
below.

The tag version must match the target package's `package.json` version, and the
tagged commit must be contained in `main`.

## Trusted publishing setup

Configure each package on npm with a GitHub Actions trusted publisher:

| package | organization | repository | workflow filename | environment |
| --- | --- | --- | --- | --- |
| `@onkernel/cua-ai` | `kernel` | `cua` | `release-cua-ai.yml` | leave blank |
| `@onkernel/cua-agent` | `kernel` | `cua` | `release-cua-agent.yml` | leave blank |


The same configuration can be created from the npm CLI:

```sh
npm install -g npm@^11.17.0
npm trust github @onkernel/cua-ai --repo kernel/cua --file release-cua-ai.yml --allow-publish
npm trust github @onkernel/cua-agent --repo kernel/cua --file release-cua-agent.yml --allow-publish
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

## First publish of a new package name

npm requires a package to exist before a trusted publisher can be configured for
it, so the first release of any new name is a manual publish from a local
checkout. This applies to `@onkernel/cua-pi-extension` today, and will apply to
the renamed single package.

Two related constraints, because a trusted publisher is bound to a
*(repository, workflow filename)* pair:

- Renaming the repository invalidates every existing entry.
- Renaming a release workflow file does the same.

So a repository rename and a first publish are cheapest done together: one
reconfiguration instead of two.

Manual first-publish steps (from a maintainer machine with an npm account in the
`onkernel` org):

```sh
git clone https://github.com/kernel/cua.git
cd cua && git checkout main && git pull --ff-only

npm ci
npm run build
npm test --workspace @onkernel/<package>

# Pack, install into a throwaway project, and import it before publishing —
# published npm versions are immutable.
PACK_DIR=$(mktemp -d)
npm pack --workspace @onkernel/<package> --pack-destination "$PACK_DIR"
SMOKE_DIR=$(mktemp -d)
(cd "$SMOKE_DIR" && npm init -y > /dev/null && npm install "$PACK_DIR"/*.tgz)

npm login
npm publish --workspace @onkernel/<package> --access public
```

Then configure the trusted publisher, either on the package page in the npm web
UI (Settings → Publishing access → Add trusted publisher) or from the CLI:

```sh
npm install -g npm@^11.17.0
npm trust github @onkernel/<package> --repo kernel/<repo> --file <workflow>.yml --allow-publish
```
