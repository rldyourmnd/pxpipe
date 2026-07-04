Last commit: 77a10e0

# Known gaps / open debt

## Imaged exact-string recall is lossy

`README.md:56-62` ("The honest part"): exact 12-char hex strings in dense
imaged content — **13/15** on Fable 5, **0/15** on Opus — "misses are *silent
confabulations*, not errors." Byte-exact values (IDs, hashes, secrets) must
stay text; recent turns already do (via the history-collapse live tail, see
`mem:CORE-01-INDEX` → `history.ts`). README states: "A dedicated verbatim-risk
guard is not built yet."

`FINDINGS.md:143-148` (`eval/gsm8k/` harness, N=100, same images, a separate/
more recent eval than the applicability.ts opt-in comment's cited numbers):
imaged arithmetic reads — Opus 4-8 93/100, Fable-5 100/100, vs. 100/100 text
baseline for both. `FINDINGS.md:202`: pxpipe is "a real ~68% gist compressor
with one fixable silent-confabulation gap — measured live, apples-to-apples,
on Opus 4.8."

Mitigations that exist today: `src/core/factsheet.ts` (exact-value tokens kept
as text next to images, see `mem:FACTSHEET-01-EXACT-VALUES`) and a prompting
change discouraging guessing exact strings from imaged text — commit
`29b82bd` "fix(prompting): discourage guessing exact strings from imaged
text" (per `git log`).

## RecoverableBlock scaffolding is not wired to a model-callable tool

`src/core/transform.ts` defines `RecoverableBlock` (`transform.ts:56-58`) and
an `emitRecoverable` option (`transform.ts:124`, default `false` at
`transform.ts:151`) that records original text + provenance for imaged
live-region blocks via `recordRecoverable` (`transform.ts:792-796`, called at
`transform.ts:1837,1910,1987`). It is re-exported through `src/core/index.ts`
and `src/core/library.ts` for library consumers.

`docs/LEGIBILITY-AUDIT-2026-07-01.md:101,112` states the recovery channel is
"Scaffolded, not yet exposed": a model-callable "rehydrate this region as
text" tool is described as "the real answer" but has not been built — only
the library-level `emitRecoverable` → `RecoverableBlock[]` API exists
(exercised by `tests/recoverable.test.ts`, which tests the `emitRecoverable`
recovery channel directly, not any exposed tool).

## Opus stays opt-in pending density measurement

`applicability.ts:27-32` excludes `claude-opus-4-8` (and GPT 5.5) from
`DEFAULT_MODEL_BASES` by default, citing degraded imaged-content reading (see
`mem:MODELS-01-ALLOWLIST` for exact figures and both eval citations). An
`eval/opus-density/` harness exists (`eval/opus-density/README.md`,
`eval/opus-density/run.mjs`) added by commit `c1a3de7` "test(eval): add Opus
4.8 lower-density read sweep (answers issue #6)" per `git log`. It measures
whether rendering at lower density (bigger cells: `5x8` production / `7x10`
/ `9x12`, via `RenderStyle` `cellWBonus`/`cellHBonus`, all ≤1568×728) lets
`claude-opus-4-8` read exact strings reliably enough to justify an opt-in
profile (`eval/opus-density/README.md:1-25`). Acceptance bar
(`eval/opus-density/README.md:42-48`): gist recall matching the text
baseline, zero silent wrong exact strings on protected exact-identifier
tasks, and positive token savings on dense content — "Enabling Opus in
`DEFAULT_MODEL_BASES` is explicitly out of scope until then"
(`eval/opus-density/README.md:50-52`). Results are written to
`eval/opus-density/results.json`; per `eval/opus-density/README.md:65-67` that
file holds no committed results yet — the harness exists but has not been run
against a live model in the reviewed code, so this is an open measurement,
not a landed conclusion.
