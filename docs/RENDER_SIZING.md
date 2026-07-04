# How pxpipe sizes a rendered image — rules, reasons, and history

This documents *why* a pxpipe PNG has the dimensions it does. It exists because
the sizing looks arbitrary until you know what was tried and rejected.

## TL;DR — current behavior

A rendered page is a **content-width, variable-height** image, clamped to a
**1568×728** ceiling so it is billed linearly (WYSIWYG) by Anthropic.

- **Width follows content, up to a cap.** The canvas is `2·PAD_X + cols·CELL_W`,
  where `cols` starts at the path default (`DEFAULT_COLS = DENSE_CONTENT_COLS =
  312` → `8 + 312·5 = 1568px`, the `MAX_WIDTH_PX` cap) and is then narrowed by
  `shrinkColsToContent` to the widest actual line (never below it). Dense
  reflowed content already fills ~`cols`, so the common case stays at 1568px; a
  page of short lines renders narrower and therefore cheaper.
- **Height grows to fit the lines on the page**, capped, then pages:
  `height = 2·PAD_Y + nLines·CELL_H` → `8 + 8·nLines`.
- **Vertical cap → paging**: `maxLines = floor((MAX_HEIGHT_PX − 2·PAD_Y) / CELL_H)`
  `= floor(720/8) = 90` lines. Overflow goes to the next image; it never grows the
  canvas. A *full* page is `1568 × 728` (≈28k chars); a *partial* page (small
  tool_result, last page) is short, e.g. `1568 × 160`.

The `1568×728` ceiling (1.14 MP) sits under **both** Anthropic tier limits, so
every pxpipe page is billed at its raw patch count with no server-side downscale
(WYSIWYG: billed pixels == rendered pixels). See "Billing model" below.

Source of truth: `renderChunkToPng` in `src/core/render.ts` (the `width` /
`height` lines), constants `PAD_X=PAD_Y=4`, `CELL_W=5`, `CELL_H=8` (the "5×8
cell"), `DEFAULT_COLS=312`, `DENSE_CONTENT_COLS=312`, `MAX_WIDTH_PX=1568`,
`MAX_HEIGHT_PX=728`, `READABLE_CHARS_PER_IMAGE=28080`,
`DENSE_CONTENT_CHARS_PER_IMAGE=28080`.

## The cell

Each character occupies a **5px wide × 8px tall** cell (`ATLAS_CELL_W=5`,
`ATLAS_CELL_H=8` in `src/core/atlas.ts`). The atlas is a prebaked glyph sheet;
text is rendered white-on-black then inverted to black-on-white. The cell was
**7×10 originally** and shrunk to 5×8 — smaller cell, same legibility on the
target model, more chars per pixel.

## Why shrink-to-content (and why the cap)

`shrinkColsToContent` (`src/core/render.ts`) narrows the canvas to the widest
line via `measureContentCols`; the cost gate and the renderer both call it, so
their pixel cost agrees. Because Anthropic bills the *actual* pixels (patches),
trimming dead right-margin directly cuts the bill — WYSIWYG. It never narrows
below the widest line, so row count (and thus paging) is unchanged; only the
canvas width drops.

Two forces bound the size:

1. **Content, not aspect ratio, sets the shape.** The only content pxpipe images
   is dense (it passes a profitability gate; sparse/short-line content stays
   text). After `reflow` packs that content into full-width rows, the longest
   line is ~`cols`, so dense pages still land at the 1568px cap; a page that
   happens to be narrower is rendered — and billed — narrower.
2. **The 1568×728 cap keeps billing linear.** Above ~1.15 MP (or 1568 px on the
   standard tier), Anthropic downscales the image server-side, so extra pixels
   buy no extra legible content and the on-wire size stops matching the billed
   size. Clamping to 1568×728 keeps every page in the linear, no-resize regime.

## Two render paths

- **tool_result / history images**: single-column at `DENSE_CONTENT_COLS=312`
  (≤1568px wide), paged at the 90-line cap → full pages are `1568×728`
  (~28k chars each).
- **system-slab image**: single-column at `DEFAULT_COLS=312` (≤1568px wide),
  same 728px height cap. Kept on a path that *can* use multi-column packing
  (`shrinkWidth=false`), but multi-col is **disabled by default** (`multiCol: 1`)
  because a single 312-col column already packs densely and multi-col adds OCR
  column-ordering risk without meaningful savings.

So in practice everything is single-column today; the multi-col code is retained
for backward compat.

## Billing model

Anthropic bills images by **28×28-pixel patches**, not by a pixel ratio: an image
costs `⌈width/28⌉ × ⌈height/28⌉` visual tokens, after being downscaled to fit the
model tier's limits. The two tiers:

| tier | models | max long edge | max visual tokens |
|---|---|---|---|
| high-res | Fable 5, Mythos 5, Opus 4.8, Opus 4.7, Sonnet 5 | 2576 px | 4784 |
| standard | all others | 1568 px | 1568 |

A full `1568×728` page costs `⌈1568/28⌉ × ⌈728/28⌉ = 56 × 26 = 1456` visual
tokens, and — because 1568×728 fits both tiers unchanged — that is the exact
billed cost on either tier (no downscale). `src/core/anthropic-vision.ts`
implements this (`anthropicVisionTokens`), and the proxy's per-image gate counts
the same patches (`imageTokensForRows` in `transform.ts`) plus a small
`ANTHROPIC_GATE_MARGIN` conservatism.

Historical note: the old `(w·h)/750` figure was a ~4–5% continuous approximation
of this same 28²=784 px²/patch grid and — crucially — ignored the tier downscale,
so it grossly overcharged large (pre-clamp) pages. The 1568×728 clamp plus the
exact patch count removed that error; the empirical `~/.pxpipe/events.jsonl`
slope (~733–784 px/tok on real traffic) matches the patch count directly.

## How sizing decisions are/were measured

- **L1 OCR eval** (`eval/eval-l1-ocr.mjs`): per-character read accuracy across
  render styles (cell size, reflow on/off, instruction placement, grayscale).
- **L2 session eval** (`eval/eval-l2-session.mjs`): comprehension over whole
  imaged sessions.
- **Legibility audit** (`docs/LEGIBILITY-AUDIT-2026-07-01.md`): the WYSIWYG clamp
  to 1568×728 and exact-string recall off dense pages.
- **glyph-matrix** (`eval/glyph-matrix/`, PAUSED): a per-character confusion
  matrix across render styles, paused while the reader model (Fable 5) is offline.

## History (oldest → newest)

The sizing converged through measured iteration, not a single design. Key commits:

| date | commit | change | why |
|---|---|---|---|
| 2026-05-21 | `38e852a` | add **R3 reflow** (recover line-end dead margin, ~29% glyph fill → dense) | rows were mostly empty; pack them |
| 2026-05-22 | `fbf32bb` | **pack reflow across newlines** + grayscale atlas + build **L1/L2 eval harness** | measure read fidelity of the packing |
| 2026-05-22 | `ea68340` | **in-image instruction banner** variant | L1 eval: **+1.04pp** char accuracy vs baseline |
| 2026-05-23 | `1afaa6c` | content-aware image cost + **width-shrinking** (WIP) | *tried* shrink-to-content |
| 2026-05-25 | `3c8716c` | full-canvas single-column rendering — `shrinkColsToContent` becomes a no-op | shrink gave no gain on the dense content of the day |
| 2026-05-25 | `bb8e0d8` | **page** dense tool/history images | enforce the line cap, split overflow |
| 2026-06-09 | `cdfc99d` | drop Opus, **Fable-5 only**; dense render on bare 5×8 cell | Opus misread ~7% of renders |
| 2026-06-17 | — | briefly raised the ceiling to ~1932×1932 | chase fewer image blocks at the same legibility |
| 2026-07-01 | — | **clamp to 1568×728** (WYSIWYG billing); **re-activate `shrinkColsToContent`** (→ `measureContentCols`) | the ~1932² page was downscaled server-side (billed ≠ rendered); 1568×728 = 1.14 MP is billed linearly, and trimming dead margin directly cuts the patch count |
| 2026-07-04 | — | gate + export moved to the exact **28-px patch** cost (`anthropic-vision.ts`); tiers modeled | Anthropic's documented formula is patches, not `/750`; the old constant overcharged large images |

The arc: **reflow** to stop wasting rows → **eval harness** to prove the packing
is still readable → **width-shrink** experiment → briefly reverted → **paging**
for the height cap → **model scope narrowed** to the reader that hits 100% on the
cell → **clamp to the linear-billing 1568×728 window** and re-activate
shrink-to-content → **exact patch-count cost model**.

## If you want to change the sizing

1. Add a style variant to the L1 OCR eval and measure char accuracy first.
2. Keep every page ≤ 1568×728 so it stays in Anthropic's linear (no-downscale)
   billing window on both tiers.
3. Remember the gate must be able to *predict* the size cheaply; both the gate
   and the renderer size the canvas through `shrinkColsToContent`, so they must
   keep agreeing.
