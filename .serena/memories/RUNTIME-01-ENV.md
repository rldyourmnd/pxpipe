Last commit: 77a10e0

# Runtime env vars, ports, logging, escape hatch

## Node runtime (`src/node.ts`)

- `PORT`: default `47821` (`Number(process.env.PORT ?? 47821)`,
  `node.ts:108`).
- `HOST`: default `'127.0.0.1'` (loopback-only) —
  `process.env.HOST?.trim() || '127.0.0.1'` (`node.ts:110`); comment
  (`node.ts:42`): "exposed to the LAN by default [is wrong] — Set HOST=0.0.0.0
  to opt into all interfaces". CLI help text (`node.ts:150`): "HOST — interface
  to bind (default 127.0.0.1, loopback only)."
- `ANTHROPIC_UPSTREAM`: overrides the shared `PXPIPE_UPSTREAM` for Anthropic
  calls, default `'https://api.anthropic.com'` (`node.ts:111`, help text
  `node.ts:154`).
- `OPENAI_UPSTREAM`: overrides shared upstream for OpenAI calls, default
  `'https://api.openai.com'` (`node.ts:112`, help text `node.ts:156`).
- `PXPIPE_LOG`: JSONL events path, default `~/.pxpipe/events.jsonl`
  (`path.join(os.homedir(), '.pxpipe', 'events.jsonl')`, `node.ts:119`; help
  text `node.ts:167`). Same default resolved independently in
  `src/sessions.ts:87` (`process.env.PXPIPE_LOG ?? path.join(home, '.pxpipe',
  'events.jsonl')`).
- Session/event file layout (`src/sessions.ts:21-22`): `~/.pxpipe/events.jsonl`
  (append-only JSONL from `FileTracker`) and `~/.pxpipe/4xx-bodies/${iso-ts}-
  ${sha8}.json.gz` (gzipped failure-body sidecars).

## Cloudflare Worker runtime (`src/worker.ts`)

- `Env.PXPIPE_UPSTREAM` (optional): single shared upstream base for every API
  family; family-specific vars below override it (`worker.ts:20`).
- `Env.ANTHROPIC_UPSTREAM`, `Env.OPENAI_UPSTREAM` (`worker.ts:21,24`).
- `Env.PXPIPE_WORKER_SECRET` (optional): set via `npx wrangler secret put
  PXPIPE_WORKER_SECRET` (`worker.ts:46-47`). When an API-key override is
  configured but `PXPIPE_WORKER_SECRET` is unset, the worker refuses to proxy
  (`worker.ts:75-81`: "refusing to proxy: an API key override is configured
  but PXPIPE_WORKER_SECRET is not"); when set, the presented secret must match
  it via `secretsMatch` before the request is forwarded (`worker.ts:87`). The
  secret is sent as the `x-pxpipe-secret` header.

## PXPIPE_MODELS

See `mem:MODELS-01-ALLOWLIST` — the single CSV env var gating both Anthropic
and GPT model families, resolved in `src/core/applicability.ts`.

## Escape hatch (README.md:63-66)

"Subagents on non-allowlisted models pass through as text — route byte-exact
work there (`CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-4-6`, or `model: sonnet`
in agent frontmatter)." This is a Claude-Code-side workaround for the imaged
verbatim-recall gap (see `mem:TECHDEBT-01-NOW`), not a pxpipe env var.
