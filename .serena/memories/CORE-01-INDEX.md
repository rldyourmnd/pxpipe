Last commit: 77a10e0

# pxpipe — memory index

Navigation map for `.serena/memories/`. Verify against source before trusting
any claim below a lower priority than "current file content at HEAD".

## What pxpipe is

Token-saving proxy for Claude Code: renders bulky context (system prompt, tool
docs, old history) to dense PNGs to cut input tokens. Two runtimes wrap one
runtime-agnostic `createProxy` factory:
- `src/node.ts` — `node:http` server + CLI flag parsing + dashboard. Doc
  comment at `src/node.ts:1-7`: "Wraps the runtime-agnostic `createProxy` from
  src/core/proxy.ts. ... only the request/response plumbing differs."
- `src/worker.ts` — Cloudflare Worker `fetch` export, same proxy logic
  (`src/worker.ts:1-11`).
- `createProxy` itself lives at `src/core/proxy.ts:597` (`export function
  createProxy(config: ProxyConfig = {})`).

`package.json`: name `pxpipe-proxy`, version `0.8.0` (verify current before
citing elsewhere — versions change), bin `pxpipe` → `bin/cli.js`, ESM
(`"type": "module"`), `packageManager: pnpm@10.21.0`, `engines.node: >=18`.
Public subpath exports (`package.json` `exports` map): `.` (core index),
`./transform` (library.js), `./measurement`, `./applicability`, `./proxy`,
`./node`, `./worker`.

## Core pipeline (`src/core/`)

Barrel is `src/core/index.ts`, which re-exports the public surface from each
module below:
- `applicability.ts` — model/path/method eligibility gate. See `mem:MODELS-01-ALLOWLIST`.
- `measurement.ts` — pure body-shaping for the `/v1/messages/count_tokens`
  counterfactual (`buildCountTokensBodies`, no fetch/Node APIs).
- `history.ts` — "History-image compression (Variant C)": collapses the
  largest closed-tool-sequence prefix of an Anthropic conversation into one
  synthetic `role:'user'` message with 1-N PNG image blocks; live tail (keepTail
  turns + any open tool sequence) stays text (`src/core/history.ts:1-12`).
- `render.ts` — PNG rendering + geometry constants. See `mem:RENDER-01-GEOMETRY`.
- `factsheet.ts` — extracts precision-critical exact strings so they ride as
  text next to images. See `mem:FACTSHEET-01-EXACT-VALUES`.
- `openai.ts` — GPT-5 family Chat Completions + Responses transformer, no
  cache-control breakpoints, images as `image_url`/`input_image` parts
  (`src/core/openai.ts:1-7`). Depends on `openai-history.ts` (GPT history-image
  collapse, stateless Responses API resend model) and `openai-savings.ts`
  (cache-aware GPT savings math: `imageTokens` vs `baselineImagedTokens`) and
  `gpt-model-profiles.ts` (per-model vision/render profile table, overridable
  via `PXPIPE_GPT_PROFILES` env JSON).
- `baseline.ts` — cache-aware Anthropic baseline math for the unproxied
  counterfactual; Workers-safe (no `node:`, no `Buffer`, no `process.*`).
  Exports `CACHE_CREATE_RATE = 1.25`, `CACHE_READ_RATE = 0.1`,
  `CACHE_TTL_SEC = 300` (`src/core/baseline.ts:7-14`).
- `export.ts` + `src/export-collect.ts` — `pxpipe export` CLI feature: renders
  a source text to PNG pages, extracts a factsheet, builds a manifest/prompt +
  cost report. `export.ts` is deliberately fs-free; `src/export-collect.ts`
  holds the fs-touching include/exclude/size/binary-sniff gate shared by
  directory walk, single-file, and `--git` untracked-file collection modes
  (`src/export-collect.ts:1-11`).
- `anthropic-vision.ts` — Anthropic image billing formula. See
  `mem:VISION-01-ANTHROPIC`.
- `transform.ts` — `transformRequest`, the main Anthropic Messages transform
  entry point (102KB, largest core file). Exports `ANTHROPIC_GATE_MARGIN`,
  `RecoverableBlock`, `TransformOptions`, `imageTokensForRows`,
  `estimateImageCount`, `isCompressionProfitable(Amortized)`, etc.
- `proxy.ts` — `createProxy`, request routing for Anthropic Messages + OpenAI
  Chat/Responses paths, gateway header parsing, upstream resolution.

## Memory map

- `mem:VISION-01-ANTHROPIC` — Anthropic 28px-patch vision cost model.
- `mem:RENDER-01-GEOMETRY` — render.ts page/cell geometry constants.
- `mem:MODELS-01-ALLOWLIST` — applicability.ts model allowlist + routing.
- `mem:FACTSHEET-01-EXACT-VALUES` — factsheet.ts exact-string extraction tiers.
- `mem:BUILD-01-QUALITY-GATES` — typecheck/test/build/CI commands and results.
- `mem:RUNTIME-01-ENV` — env vars, default ports/hosts, event log, escape hatch.
- `mem:TECHDEBT-01-NOW` — known gaps (verbatim recall loss, unwired rehydrate tool).

## Taxonomy rule for future memories

`AREA-01-SLUG.md` on disk and as the Serena memory name. One durable topic per
memory. Split rather than append when a memory starts carrying multiple
responsibilities. Update this index in the same pass as any new/renamed/removed
memory.
