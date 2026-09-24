# npm releases

`@onkernel/browser-loop` publishes from tags matching `browser-loop/v*` through
`.github/workflows/release-browser-loop.yml`.

## Release contract

Before pushing a tag:

1. Update `packages/browser-loop/package.json` and `package-lock.json` to the
   release version.
2. Merge that version change to `main`.
3. Tag the merged commit as `browser-loop/v<version>`.

The workflow rejects a tag when its commit is not contained in `main` or when
the tag version differs from `packages/browser-loop/package.json`.

```sh
git checkout main
git pull --ff-only
git tag browser-loop/v0.13.0
git push origin browser-loop/v0.13.0
```

npm versions and Git tags are immutable. Never reuse a failed or previously
published version; fix the problem, bump again, and create a new tag.

## What the workflow validates

The release job uses Node 24 and npm 11, then runs:

```sh
npm run check:lockfile
npm ci
npm run build --workspace @onkernel/browser-loop
npm run typecheck --workspace @onkernel/browser-loop
npm test --workspace @onkernel/browser-loop
npm pack --workspace @onkernel/browser-loop
```

It installs the packed tarball into a fresh project and verifies both package
entry points before publishing the same package to npm.

## Trusted publishing

The npm package is configured for GitHub Actions trusted publishing:

| package | organization | repository | workflow filename | environment |
| --- | --- | --- | --- | --- |
| `@onkernel/browser-loop` | `kernel` | `browser-loop` | `release-browser-loop.yml` | none |

To restore that configuration if it is removed:

```sh
npm install -g npm@^11.17.0
npm trust github @onkernel/browser-loop \
  --repo kernel/browser-loop \
  --file release-browser-loop.yml \
  --allow-publish
```

The workflow receives `id-token: write` and publishes with
`npm publish --workspace @onkernel/browser-loop --access public`; it does not use
a long-lived npm token.
