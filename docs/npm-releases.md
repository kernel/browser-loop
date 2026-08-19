# npm releases

`@onkernel/browser-loop` publishes from a package tag:

- `browser-loop/v0.11.0` runs `.github/workflows/release-browser-loop.yml`

The tag version must match `packages/browser-loop/package.json`, and the tagged
commit must be contained in `main`.

## Trusted publishing setup

Configure the package on npm with a GitHub Actions trusted publisher:

| package | organization | repository | workflow filename | environment |
| --- | --- | --- | --- | --- |
| `@onkernel/browser-loop` | `kernel` | `browser-loop` | `release-browser-loop.yml` | leave blank |

The same configuration can be created from the npm CLI:

```sh
npm install -g npm@^11.17.0
npm trust github @onkernel/browser-loop \
  --repo kernel/browser-loop \
  --file release-browser-loop.yml \
  --allow-publish
```

npm requires packages to exist before a trusted publisher can be configured, so
`@onkernel/browser-loop`'s first version is published manually — see below.

## Releasing from a tag

After the first manual publish, bump the version before creating the next tag:

```sh
git checkout main
git pull --ff-only
git tag browser-loop/v0.11.1
git push origin browser-loop/v0.11.1
```

Do not create `browser-loop/v0.11.0` after manually publishing 0.11.0: npm
versions are immutable, so the workflow would attempt to republish the same
version and fail.

## First publish of the package

npm requires a package to exist before a trusted publisher can be configured for
it. The first `@onkernel/browser-loop` release is therefore a manual publish
from a maintainer account in the `onkernel` npm organization.

Rename the GitHub repository to `kernel/browser-loop` before publishing. Trusted
publishers bind to a *(repository, workflow filename)* pair, so doing the repo
rename, first publish, and trusted-publisher setup together avoids configuring
that pair twice.

Publish the same tarball that passed the install smoke test:

```sh
git clone https://github.com/kernel/browser-loop.git
cd browser-loop
git checkout main
git pull --ff-only

npm ci
npm run build --workspace @onkernel/browser-loop
npm run typecheck --workspace @onkernel/browser-loop
npm test --workspace @onkernel/browser-loop

PACK_DIR=$(mktemp -d)
npm pack --workspace @onkernel/browser-loop --pack-destination "$PACK_DIR"
TARBALL="$PACK_DIR/onkernel-browser-loop-0.11.0.tgz"

SMOKE_DIR=$(mktemp -d)
(
  cd "$SMOKE_DIR"
  npm init -y > /dev/null
  npm install "$TARBALL"
  node --input-type=module -e \
    'import("@onkernel/browser-loop").then(m => console.log(Object.keys(m)))'
)

npm login
npm publish "$TARBALL" --access public
```

Then configure the trusted publisher using the command above or the npm package
page (Settings → Publishing access → Add trusted publisher).
