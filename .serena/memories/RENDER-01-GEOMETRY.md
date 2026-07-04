Last commit: 77a10e0

# Render geometry — `src/core/render.ts` (+ `src/core/atlas.ts`)

## Page ceiling

- `MAX_WIDTH_PX = 1568` (`render.ts:746`).
- `MAX_HEIGHT_PX = 728` (`render.ts:34`).
- Chosen so pxpipe pages are billed at their raw 28px-patch count with no
  server-side downscale on either Anthropic vision tier — see
  `mem:VISION-01-ANTHROPIC` and `docs/RENDER_SIZING.md:24-26`.

## Cell + content constants

- `DENSE_CONTENT_COLS = 312` and `DEFAULT_COLS = 312` (`render.ts:41`, `47`);
  `312 × 5px cell width = 1560px` + `2 × PAD_X(4) = 1568px = MAX_WIDTH_PX`.
- `DENSE_CONTENT_CHARS_PER_IMAGE = 28080` (`render.ts:40`).
- Bare cell is **5×8** (`ATLAS_CELL_W = 5`, `ATLAS_CELL_H = 8`, defined in
  `src/core/atlas.ts:9,11`); comment at `render.ts:42`: "A/B showed 5×8 beats
  7×10 on dense JSON (4/5 vs 3/5 reads, 42% fewer tokens)." Per
  `docs/RENDER_SIZING.md:38-40` the cell was 7×10 originally and was shrunk to
  5×8.
- `PAD_X = 4`, `PAD_Y = 4` (`render.ts:49,51`).
- `CELL_W = ATLAS_CELL_W + DEFAULT_CELL_W_BONUS`, `CELL_H = ATLAS_CELL_H +
  DEFAULT_CELL_H_BONUS`, both bonuses default `0` (`render.ts:56-60`).

## Sizing behavior (verified against `docs/RENDER_SIZING.md:6-32`, cross-checked
against `render.ts` constants above)

- A rendered page is content-width, variable-height, clamped to the
  1568×728 ceiling.
- Canvas width = `2·PAD_X + cols·CELL_W`; `cols` starts at `DEFAULT_COLS = 312`
  (→ 1568px) and is narrowed by `shrinkColsToContent` to the widest actual
  line, never below it.
- Canvas height = `2·PAD_Y + nLines·CELL_H`; vertical cap gives
  `maxLines = floor((728 − 8) / 8) = 90` lines per page before paging to the
  next image.

## Content-width measurement

- `shrinkColsToContent(text, cols, markerScale)` (`render.ts:265-271`)
  delegates to `measureContentCols(text, maxCols, markerScale)`
  (`render.ts:282`+); both the cost gate and the renderer call the same
  function so their pixel-cost predictions agree.
- Transform-side default: `DEFAULTS.cols = 312` in `src/core/transform.ts:141`
  (matches `DEFAULT_COLS`/`DENSE_CONTENT_COLS`).

## Caveat baked into the module

`render.ts:39`: "verbatim recall of imaged text is unreliable at any size" —
see `mem:TECHDEBT-01-NOW` for the measured recall numbers.
