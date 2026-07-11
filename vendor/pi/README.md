# Pi message-anchored tool packages

These four tarballs are built from upstream pi-mono commit
`3d8f74357c169d24f996a1611ecc4be72b7744bd`, the first commit containing
message-anchored dynamic tool loading. npm had not published a release containing
that commit when this change was implemented.

All package versions and internal `@earendil-works/*` dependencies were rewritten
to the shared prerelease version `0.80.7-anchor.3d8f743` before running the normal
upstream build and `npm pack`. Replace these file dependencies with the first
normal npm release containing the commit before merging when one is available.

SHA-256:

- `earendil-works-pi-ai-0.80.7-anchor.3d8f743.tgz`: `04a7e2f330b56b6352d3a72b1b8785f8549dd68a985ca84c145bd4b1a8456f38`
- `earendil-works-pi-agent-core-0.80.7-anchor.3d8f743.tgz`: `d1ba7fce6f448ab4bd16baddfb4ae3d3d7f07c77b2f014ab63588aa4b9c09c1d`
- `earendil-works-pi-coding-agent-0.80.7-anchor.3d8f743.tgz`: `9af582b60b08fdab90d9b2c9bf8040ae410131e6785c77d844f9b87aeb714600`
- `earendil-works-pi-tui-0.80.7-anchor.3d8f743.tgz`: `a8ffd52318c8af5674c70f176489fe44117e2ea267f7b0712bb538a1f35450a9`
