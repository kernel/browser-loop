# npm releases

`@onkernel/loop` publishes from a package tag:

- `loop/v0.11.0` runs `.github/workflows/release-loop.yml`

The tag version must match `packages/loop/package.json`, and the tagged commit
must be contained in `main`.

## Trusted publishing setup

Configure the package on npm with a GitHub Actions trusted publisher:

| package | organization | repository | workflow filename | environment |
| --- | --- | --- | --- | --- |
| `@onkernel/loop` | `kernel` | `cua` | `release-loop.yml` | leave blank |

The same configuration can be created from the npm CLI:

```sh
npm install -g npm@^11.17.0
npm trust github @onkernel/loop --repo kernel/cua --file release-loop.yml --allow-publish
```

npm requires packages to exist before a trusted publisher can be configured, so
`@onkernel/loop`'s first version is published manually — see below.

## Releasing from a tag

```sh
git checkout main
git pull --ff-only
git tag loop/v0.11.0
git push origin loop/v0.11.0
```

## First publish of a new package name

npm requires a package to exist before a trusted publisher can be configured for
it, so the first release of any new name is a manual publish from a local
checkout. This applies to `@onkernel/loop`, whose predecessors published under
the retired `@onkernel/cua-ai` and `@onkernel/cua-agent` names.

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
