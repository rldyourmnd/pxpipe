Last commit: 77a10e0

# Build / test / CI — quality gates

## Commands (`package.json` `scripts`)

- `pnpm run typecheck` → `tsc --noEmit`.
- `pnpm test` → `vitest run`. `pnpm test:watch` → `vitest`.
- `pnpm run build` → `node scripts/build.mjs`.
- `pnpm run prepublishOnly` → chains `typecheck && test && build`.
- `pnpm run test:restart` → `bash tests/restart.test.sh`.
- `pnpm run dev:node` → `tsx watch src/node.ts`; `dev:worker` → `wrangler dev`.
- `pnpm run deploy:worker` → `wrangler deploy`.

## Verified test status at HEAD (77a10e0)

Ran `pnpm test` locally: **34 test files passed (34), 663 tests passed
(663)**, zero failures (vitest v4.1.6). Test files live in `tests/*.test.ts`
(34 files; `tests/fixtures/` and `tests/restart.test.sh` are not `.test.ts`
files and are not counted in the 34).

## Build pipeline (`scripts/build.mjs`)

1. Removes `dist/`, recreates it.
2. Runs `pnpm exec tsc -p tsconfig.json` (emits library ESM + `.d.ts`); exits
   non-zero on tsc failure (`scripts/build.mjs:16-25`).
3. Bundles `src/node.ts` → `dist/node.js` via esbuild: `bundle: true`,
   `platform: 'node'`, `target: 'node18'`, `format: 'esm'`, `sourcemap: true`,
   `banner: { js: '#!/usr/bin/env node' }`, and `define: { __PXPIPE_VERSION__:
   JSON.stringify(pkg.version) }` — the CLI version is inlined at build time
   from `package.json`, not read from `npm_package_version` at runtime
   (`scripts/build.mjs:10-14,27-42`).
4. Version smoke check: runs the freshly bundled `dist/node.js --version` and
   fails the build (`process.exit(1)`) if the printed version doesn't exactly
   match `pkg.version` (`scripts/build.mjs:46-58`).
5. Worker target: `wrangler dev`/`wrangler deploy` build `src/worker.ts`
   directly; `dist/worker.js` is also emitted via the tsc step for package
   consumers (`scripts/build.mjs:1-4`).

## CI (`.github/workflows/ci.yml`)

- Triggers: `push` to `main`, and `pull_request` (any branch).
- `permissions: contents: read` at workflow level — least privilege; comment
  states CI "only reads the checkout; it never writes to the repo, creates
  releases, or comments" (`ci.yml:8-11`).
- `concurrency`: group `ci-${{ github.ref }}`, `cancel-in-progress: true` —
  cancels superseded runs on the same ref, e.g. a force-push to a PR branch.
- Single `test` job on `ubuntu-latest`: `actions/checkout@v7`,
  `pnpm/action-setup@v6`, `actions/setup-node@v6` with `node-version: 22` and
  `cache: pnpm`, then `pnpm install --frozen-lockfile`, `pnpm run typecheck`,
  `pnpm test`, `pnpm run build` (`ci.yml:18-32`).

## Package manager / runtime pins

`package.json`: `"packageManager": "pnpm@10.21.0"`, `"engines": { "node":
">=18" }`. Locally verified `pnpm --version` = `10.21.0`, `node --version` =
`v24.16.0` (dev machine; CI pins Node 22 via `actions/setup-node@v6`).
