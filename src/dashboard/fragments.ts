// Server-rendered HTML for the dashboard - the AHA-without-the-A stack:
// HTML fragments over the wire (htmx polls + swaps), Alpine for the little
// bits of client state (toast tray). No client bundle, no build step - the
// browser receives finished markup from the same process that owns the data.
//
// Layout, classes, colors and copy match the retired Svelte components 1:1
// so the page is a visual no-op pre/post rewrite. Each former component is
// now a render*Fragment() function; the polling cadence (2s live, 5s slow)
// moved from Svelte stores to `hx-trigger="every Ns"` attributes.

import { HTMX_JS, ALPINE_JS } from './vendor.js';
import type {
  StatsPayload,
  RecentPayload,
  RecentRow,
  SessionsPayload,
  SessionRow,
  FullStatsPayload,
  CurrentSessionPayload,
} from './types.js';

// ---- tiny helpers (formerly src/dashboard/lib/format.ts) ----------------

export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

function numFmt(n: number | null | undefined): string {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-US');
}

function formatDuration(s: number): string {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? h + 'h ' : '') + (m || h ? m + 'm ' : '') + sec + 's';
}

function shortPath(p: string | null | undefined): string {
  if (!p) return '-';
  const parts = String(p).split('/');
  return parts[parts.length - 1] || p;
}

// ---- compression toggle + passthrough banner -----------------------------

export function renderToggleFragment(enabled: boolean): string {
  const banner = enabled
    ? ''
    : `<div class="banner"><strong>PASSTHROUGH MODE</strong> - compression disabled. Every /v1/messages forwards unchanged to upstream. No image encoding, no break-even gate, no transforms.</div>`;
  // The button POSTs the OPPOSITE of the rendered state - the fragment is
  // re-rendered with fresh state on every poll, so the value can't go stale
  // (the legacy UI read state out of the button label; the Svelte UI carried
  // it in a store; here the server just bakes it into the markup).
  const confirm = enabled
    ? ` hx-confirm="Disable compression?\n\n/v1/messages will forward unchanged to upstream. Use this when upstream is unhealthy or to A/B test the proxy. Restart resets to enabled."`
    : '';
  return (
    banner +
    `<div class="toggle-wrap">` +
    `<button class="toggle" type="button" hx-post="/fragments/toggle" hx-target="#frag-toggle" hx-vals='{"enabled": ${!enabled}}'${confirm}>` +
    (enabled ? 'Disable compression' : 'Enable compression') +
    `</button>` +
    `<span class="hint">runtime kill switch &middot; not persisted across restart</span>` +
    `</div>`
  );
}

// ---- compress scope (which models get imaged) ----------------------------

/** Convenience catalog of common Anthropic models shown as chips by default.
 *  NOT exhaustive and NOT a gate — the chip set is the UNION of this catalog,
 *  the env-configured scope (`PXPIPE_MODELS` or the Fable-only default), and
 *  whatever is currently active, so any model the env var can enable stays
 *  toggleable. Fable 5 reads renders cleanly; Opus 4.8/4.7 read imaged content
 *  at a tax (see FINDINGS.md); Sonnet/Haiku read-fidelity is unvalidated — the
 *  catalog just makes them one click, it does not endorse them. Labels are
 *  cosmetic; an id not in the catalog renders with the raw id as its label. */
const MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

/** "compress models" chips. The chip set is the UNION of MODEL_CATALOG, the
 *  env-configured scope (`configured`, from PXPIPE_MODELS or the Fable-only
 *  default), and the currently-active scope (`active`) — so a model enabled via
 *  the env var is always shown and can be toggled off AND back on (it no longer
 *  vanishes once it leaves the active set). `active` lights the chip; every chip
 *  routes through the same /fragments/models toggle. */
export function renderModelsFragment(
  active: string[],
  configured: string[],
  enabled: boolean,
): string {
  const on = new Set(active);
  const labelOf = new Map(MODEL_CATALOG.map((m) => [m.id, m.label]));
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of [...MODEL_CATALOG.map((m) => m.id), ...configured, ...active]) {
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  const chips = ids
    .map((id) => {
      const lit = on.has(id);
      const label = labelOf.get(id) ?? id;
      return (
        `<button class="chip${lit ? ' on' : ''}" type="button" ` +
        `hx-post="/fragments/models" hx-target="#frag-models" ` +
        `hx-vals='{"model":"${id}","on":${!lit}}'>${label}${lit ? ' ✓' : ''}</button>`
      );
    })
    .join('');
  const moot = enabled ? '' : ` <span class="hint">compression off &middot; scope moot</span>`;
  return (
    `<div class="models-wrap">` +
    `<span class="models-label">compress models</span>` +
    chips +
    `<span class="hint">click to toggle &middot; runtime only, not persisted</span>${moot}` +
    `</div>`
  );
}

// ---- context map (how this request's context was transformed) -------------

export interface ContextMapData {
  id: number; // first image id for this request (matches the recent-table view link)
  baselineTokens: number; // count_tokens of the body as text
  realInput: number; // input + cache_create + cache_read (server-measured)
  output: number;
  imageCount: number;
  buckets: Partial<Record<string, number>>; // bucket -> exact chars rendered to PNG
  imageIds: number[]; // every rendered page's image-ring id, for the gallery
  compressed: boolean;
}

const CTXMAP_BUCKETS: ReadonlyArray<readonly [string, string]> = [
  ['static_slab', 'static slab (system + tools + CLAUDE.md)'],
  ['reminder', 'system-reminder blocks'],
  ['tool_result_prose', 'tool results — prose'],
  ['tool_result_log', 'tool results — logs'],
  ['tool_result_json', 'tool results — JSON'],
  ['history', 'collapsed history'],
];

/** "How your context works" panel for the latest request: real token flow
 *  (as-text -> real) plus the exact-char breakdown of what became images. Real
 *  tokens are the server's count; per-row chars are exact pre-render. No cpt
 *  guesswork — headline in tokens, breakdown in chars. */
export function renderContextMapFragment(
  c: ContextMapData | undefined,
  history: ContextMapData[] = [],
  notFound = false,
): string {
  const k = (n: number): string =>
    n >= 1000 ? (n / 1000).toFixed(n >= 100_000 ? 0 : 1) + 'k' : String(Math.round(n));
  const isLatest = c !== undefined && c.id === (history.at(-1)?.id ?? -1);
  if (notFound) {
    return `<div class="ctxmap"><div class="hint">That request's context breakdown is no longer available — it was evicted (only the most recent requests are kept) or had no token usage recorded. Click <strong>view</strong> on a more recent row.</div></div>`;
  }
  if (!c || (c.baselineTokens <= 0 && c.imageCount <= 0)) {
    return `<div class="ctxmap"><div class="hint">Click <strong>view</strong> on a request above to see how its context was transformed.</div></div>`;
  }
  const base = c.baselineTokens;
  const real = c.realInput;
  const pct = base > 0 ? Math.round((1 - real / base) * 100) : 0;
  const rows = CTXMAP_BUCKETS.map(([key, label]) => [label, c.buckets[key] ?? 0] as const)
    .filter(([, ch]) => ch > 0)
    .map(
      ([label, ch]) =>
        `<div class="ctxmap-row"><span class="ctxmap-lbl">${label}</span><span class="ctxmap-val">${k(ch)} chars</span></div>`,
    )
    .join('');
  const head =
    base > 0
      ? `${k(base)} tok as text &rarr; <strong>${k(real)} tok real</strong> &middot; <span class="ctxmap-pct">&minus;${pct}%</span>`
      : `<strong>${k(real)} tok real</strong>`;
  const title = isLatest ? 'CONTEXT BREAKDOWN — latest' : 'CONTEXT BREAKDOWN — selected request';
  const ids = c.imageIds ?? [];
  const gallery = ids.length
    ? `<div class="ctxmap-imgs-title">${ids.length} rendered page${ids.length === 1 ? '' : 's'} sent to the model (scroll):</div>` +
      `<div class="ctxmap-imgs">` +
      ids
        .map(
          (id) =>
            `<img class="ctxmap-img" src="/proxy-latest-png?id=${id}" alt="page ${id}" loading="lazy" title="page ${id}" onerror="this.classList.add('img-gone'); this.alt='page ${id} evicted from buffer';" />`,
        )
        .join('') +
      `</div>`
    : '';
  return (
    `<div class="ctxmap">` +
    `<div class="ctxmap-head"><strong>${title}</strong> &middot; ${head} &middot; ${c.imageCount} image page${c.imageCount === 1 ? '' : 's'}</div>` +
    `<div class="ctxmap-sub">became images — exact chars rendered to PNG (pxpipe is lossy on these):</div>` +
    (rows || `<div class="ctxmap-row hint">nothing imaged this request</div>`) +
    `<div class="ctxmap-foot hint">headline tokens are the server's real count (input + cache); per-row values are exact pre-render chars. Output (${k(c.output)} tok) is never imaged.</div>` +
    gallery +
    `</div>`
  );
}

// ---- current-session headline --------------------------------------------

// MUST stay in lockstep with the server-side `ASSUMED_INPUT_USD_PER_MTOK`
// in src/dashboard.ts (see that constant's comment for the rate rationale).
const INPUT_USD_PER_MTOK = 10.0;

export function renderSessionSummaryFragment(data: CurrentSessionPayload): string {
  const measured = data.baselineMeasuredCount ?? 0;
  if (measured <= 0) return '';
  // HEADLINE: raw, rate-free TOTAL token reduction (input + output), real server
  // numbers, one division — no rate weighting. Output isn't compressed, so it's
  // added to BOTH sides (headlining input-only would cherry-pick).
  const rawActual = data.rawActualTokens ?? 0;       // input side, real (in+cc+cr)
  const rawBaseline = data.rawBaselineTokens ?? 0;   // input side, as text (count_tokens)
  const rawOutput = data.rawOutputTokens ?? 0;       // reply (same both sides, uncompressed)
  const ppTotal = rawActual + rawOutput;
  const textTotal = rawBaseline + rawOutput;
  const totalPct = textTotal > 0 ? (1 - ppTotal / textTotal) * 100 : 0;
  // Honest sign: pxpipe can cost MORE on a session (cc-heavy turns, or the
  // passthrough control), so phrase a negative as "more tokens" rather than
  // render a garbled "-7% fewer tokens".
  const totalLabel =
    totalPct >= 0 ? `${totalPct.toFixed(0)}% fewer tokens` : `${(-totalPct).toFixed(0)}% more tokens`;
  const inputPct = rawBaseline > 0 ? (1 - rawActual / rawBaseline) * 100 : 0;
  const k = (t: number) => `${(t / 1000).toFixed(0)}k`;
  return (
    `<div class="line">` +
    `<span class="label">THIS SESSION</span>` +
    ` &mdash; <span class="num">${totalLabel}</span>` +
    ` (<span class="num">${k(ppTotal)}</span> vs <span class="muted">${k(textTotal)}</span> total)` +
    ` &mdash; <span class="muted">${measured} requests</span>` +
    `</div>` +
    `<div class="line"><span class="small muted">` +
    `total = input + output, real server tokens. input compressed <b>${inputPct.toFixed(0)}%</b> ` +
    `(${k(rawActual)} vs ${k(rawBaseline)} as text); output <b>not</b> compressed (${k(rawOutput)}, same both sides). ` +
    `No rates, no assumptions &mdash; what it saves in $ depends on pricing; weekly-cap weight unknown.` +
    `</span></div>`
  );
}

// ---- stats header: sub-line + savings cards + diagnostic ------------------

function mathRow(key: string, val: number | string | undefined, note = ''): string {
  const v = typeof val === 'number' ? numFmt(val) : String(val ?? '-');
  return `<div><span class="k">${key}:</span> <span class="v">${escapeHtml(v)}</span> <span class="k">${note}</span></div>`;
}

// `id` keeps <details> open state across htmx swaps (see glue script in the
// page shell - open ids are recorded before swap and restored after).
function details(id: string, summary: string, body: string, cls = 'math'): string {
  return `<details class="${cls}" id="${id}"><summary>${summary}</summary><div class="formula">${body}</div></details>`;
}

export function renderHeaderFragment(s: StatsPayload, port: number): string {
  const pa = s.pricing_assumptions;
  const sub = `port ${port} &middot; uptime ${formatDuration(s.uptime_sec)} &middot; live`;

  const savedMath =
    `<div><span class="k">formula:</span> <span class="v">saved = baseline - actual</span></div>` +
    `<div><span class="k">weights:</span> <span class="v">input&times;1.0, cache_create&times;1.25, cache_read&times;0.10</span></div>` +
    `<div style="height:6px"></div>` +
    mathRow('baseline', s.baseline_input_weighted, '(cache-aware: cacheable&times;weight + cold_tail)') +
    mathRow('actual', s.actual_input_weighted, '(input + cc&times;1.25 + cr&times;0.10 from usage)') +
    mathRow('saved', s.saved_input_tokens, `<span class="op">=</span> baseline - actual`) +
    `<span class="src">output excluded - identical with/without compression</span>`;

  const usdMath =
    `<div><span class="k">formula:</span> <span class="v">$ saved = saved_tokens &times; $${pa.input_per_mtok}/Mtok</span></div>` +
    `<div style="height:6px"></div>` +
    mathRow('saved_tokens', s.saved_input_tokens, '(cache-aware, input-side)') +
    mathRow('saved_usd', `$${(s.saved_usd || 0).toFixed(4)} `, `<span class="op">=</span> saved_tokens &times; input_rate / 1e6`) +
    `<span class="src">source: ${escapeHtml(pa.source || 'docs.anthropic.com pricing')}</span>`;

  const splitMath =
    `<div><span class="k">formula:</span> <span class="v">bucket_$ = (&Sigma; actual_input + &Sigma; output &times; ${pa.output_multiplier}) &times; $${pa.input_per_mtok}/Mtok</span></div>` +
    `<div><span class="k">why:</span> <span class="v">partition the paid-rows set by which path actually ran this turn (\`info.compressed = true\` for slab/history compression; false for passthrough or bypassed). Same $/Mtok rate on both sides so the rate-assumption bias cancels in the delta. Selection bias (the gate routes each turn) does NOT cancel - interpret with sample counts.</span></div>` +
    `<div style="height:6px"></div>` +
    mathRow(`compressed (n=${s.compressed_paid_requests})`, `$${(s.compressed_actual_usd || 0).toFixed(4)}`, `total &middot; avg $${(s.compressed_avg_usd_per_request || 0).toFixed(4)}/req`) +
    mathRow(`passthrough (n=${s.passthrough_paid_requests})`, `$${(s.passthrough_actual_usd || 0).toFixed(4)}`, `total &middot; avg $${(s.passthrough_avg_usd_per_request || 0).toFixed(4)}/req`) +
    mathRow(
      'compressed - passthrough',
      `$${(s.compressed_minus_passthrough_avg_usd || 0).toFixed(4)}/req`,
      s.split_sufficient_sample
        ? `(both buckets &ge; ${s.split_min_sample_per_bucket} - delta is meaningful)`
        : `(small sample: need &ge; ${s.split_min_sample_per_bucket} per bucket; treat delta as noisy)`,
    ) +
    `<span class="src">no counterfactual, no probe gate - pure observed $/req on each path</span>`;

  const tokeqMath =
    `<div><span class="k">formula:</span> <span class="v">token_equivalent = input + output &times; ${pa.output_multiplier}</span></div>` +
    `<div><span class="k">why:</span> <span class="v">matches Anthropic's per-Mtok price ratio ($${pa.input_per_mtok} input vs $${pa.input_per_mtok * pa.output_multiplier} output)</span></div>` +
    `<div style="height:6px"></div>` +
    mathRow('actual_input', s.actual_input_weighted, '(weighted upstream usage)') +
    mathRow('actual_token_equivalent', s.actual_token_equivalent) +
    mathRow('baseline_token_equivalent', s.baseline_token_equivalent, `(unproxied counterfactual, same &times;${pa.output_multiplier} on output)`) +
    `<div style="height:6px"></div>` +
    mathRow('events_with_measurement', s.events_with_measurement, '(events where SSE/JSON scanner produced char counts)') +
    mathRow('measured_text_chars', s.measured_text_chars, '(content_block_delta &middot; text_delta + response content[].text)') +
    mathRow('measured_thinking_chars', s.measured_thinking_chars, '(content_block_delta &middot; thinking_delta + response reasoning text)') +
    mathRow('measured_tool_use_chars', s.measured_tool_use_chars, '(content_block_delta &middot; input_json_delta + tool_use blocks)') +
    mathRow('measured_redacted_blocks', s.measured_redacted_block_count, '(opaque encrypted blocks - chars unavailable, billed but unmeasurable)') +
    `<span class="src">measured - no estimation</span>`;

  const pctMath =
    `<div><span class="k">formula:</span> <span class="v">share_of_spend = saved / (all_baseline_equivalent + all_output &times; ${pa.output_multiplier})</span></div>` +
    `<div><span class="k">why this is diagnostic, not the headline:</span> <span class="v">this is a counterfactual ("what the user WOULD have paid"). It depends on the count_tokens probe, the cache-aware baseline split, and an input-rate assumption. Useful as a sanity check, but the operator's real question is "did the compressed path cost less per request than the passthrough path on real traffic" - that's the headline split above, no counterfactuals.</span></div>` +
    `<div style="height:6px"></div>` +
    mathRow('saved', s.saved_input_tokens, '(measured-rows numerator; cache-aware)') +
    mathRow('all_baseline_equivalent', s.all_baseline_equivalent_weighted, '(every paid request, weighted; baseline on measured + actual on the rest)') +
    mathRow(`all_output &times; ${pa.output_multiplier}`, s.all_output_weighted, `(every paid request, output &times; ${pa.output_multiplier})`) +
    mathRow('all_counterfactual_total', s.all_baseline_equivalent_weighted + s.all_output_weighted, `<span class="op">=</span> all_baseline_equivalent + all_output`) +
    mathRow('share_of_spend', (s.saved_pct_of_all_spend || 0).toFixed(1) + '%', `<span class="op">=</span> saved / all_counterfactual_total &times; 100`) +
    mathRow('all_usage_requests', s.all_usage_requests, '(denominator request count - compressed + passthrough + probe-failed)') +
    `<span class="src">measured numerator, all-rows counterfactual denominator - bounded at 100%</span>`;

  const delta = s.compressed_minus_passthrough_avg_usd ?? 0;
  const splitCard = s.split_sufficient_sample
    ? `<div class="value ${delta <= 0 ? 'pos' : 'neg'}">${delta >= 0 ? '+$ ' : '-$ '}${Math.abs(delta).toFixed(4)}</div>` +
      `<div class="small">negative = compressed path cheaper &middot; both buckets &ge; ${s.split_min_sample_per_bucket}</div>`
    : `<div class="value small-sample">small sample</div>` +
      `<div class="small">need &ge; ${s.split_min_sample_per_bucket} requests per bucket &middot; have ${numFmt(s.compressed_paid_requests)} / ${numFmt(s.passthrough_paid_requests)}</div>`;

  return (
    `<div class="sub">${sub}</div>` +
    `<div class="grid">` +
    `<div class="card"><div class="label">requests</div><div class="value">${numFmt(s.requests)}</div><div class="small">&mdash; ${numFmt(s.compressed_requests)} compressed</div></div>` +
    `<div class="card"><div class="label">input tokens saved</div><div class="value pos">${numFmt(s.saved_input_tokens)}</div><div class="small">cache-aware, input-side only</div>${details('math-saved', 'show calculation', savedMath)}</div>` +
    `<div class="card"><div class="label">$ saved</div><div class="value">$ ${(s.saved_usd ?? 0).toFixed(2)}</div><div class="small">at $${pa.input_per_mtok}/M input tokens</div>${details('math-usd', 'show calculation', usdMath)}</div>` +
    `<div class="card"><div class="label">compressed $/req</div><div class="value">$ ${(s.compressed_avg_usd_per_request ?? 0).toFixed(4)}</div><div class="small">n=${numFmt(s.compressed_paid_requests)} &middot; total $ ${(s.compressed_actual_usd ?? 0).toFixed(4)}</div></div>` +
    `<div class="card"><div class="label">passthrough $/req</div><div class="value">$ ${(s.passthrough_avg_usd_per_request ?? 0).toFixed(4)}</div><div class="small">n=${numFmt(s.passthrough_paid_requests)} &middot; total $ ${(s.passthrough_actual_usd ?? 0).toFixed(4)}</div></div>` +
    `<div class="card"><div class="label">compressed - passthrough $/req</div>${splitCard}${details('math-split', 'show calculation', splitMath)}</div>` +
    `</div>` +
    details(
      'diag-pct',
      'diagnostic: counterfactual "share of spend saved"',
      `<div class="diag-headline">share of spend saved (counterfactual): <span class="${(s.saved_pct_of_all_spend ?? 0) >= 0 ? 'pos' : 'neg'}">${(s.saved_pct_of_all_spend ?? 0).toFixed(1)}%</span> <span class="small">(${numFmt(s.all_usage_requests)} paid req &middot; compressed + passthrough + probe-failed)</span></div>` +
        pctMath,
      'diagnostic',
    ) +
    details('diag-tokeq', `token-equivalent total: ${numFmt(s.actual_token_equivalent)} (input + ${pa.output_multiplier}&times;output)`, tokeqMath, 'diagnostic')
  );
}

// ---- recent requests table ------------------------------------------------

function statusCls(status: number): string {
  if (status >= 500) return 'bad';
  if (status >= 400) return 'warn';
  return 'good';
}

export function renderRecentFragment(p: RecentPayload): string {
  const rows = (p.recent ?? []).slice().reverse();
  const body =
    rows.length === 0
      ? `<tr><td colspan="9" class="small" style="color:#6e7681">no requests yet</td></tr>`
      : rows
          .map((e: RecentRow, i: number) => {
            const viewId = (e.img_ids ?? (e.img_id != null ? [e.img_id] : []))[0];
            const viewLink =
              viewId != null
                ? `<a class="rec-view" href="#" hx-get="/fragments/context-map?req=${viewId}" hx-target="#frag-context-map" hx-swap="innerHTML">view</a>`
                : `<span class="muted">-</span>`;
            const saved = e.session_saved_so_far_delta ?? 0;
            return (
              `<tr>` +
              `<td>${i + 1}</td>` +
              `<td class="num ${statusCls(e.status)}">${e.status}</td>` +
              `<td class="small">${escapeHtml(shortPath(e.path))}</td>` +
              `<td class="num">${e.cc_added ? '&check;' : '-'}</td>` +
              `<td class="num">${e.cache_read != null ? numFmt(e.cache_read) : '-'}</td>` +
              `<td class="num">${e.baseline_input != null ? numFmt(e.baseline_input) : '-'}</td>` +
              `<td class="num">${e.actual_input != null ? numFmt(e.actual_input) : '-'}</td>` +
              `<td class="num pos">${saved > 0 ? '+' + numFmt(saved) : '-'}</td>` +
              `<td class="num">${viewLink}</td>` +
              `</tr>`
            );
          })
          .join('');
  return (
    `<table><thead><tr><th>#</th><th class="num">status</th><th>path</th><th class="num">cc</th><th class="num">cr</th><th class="num">baseline</th><th class="num">actual</th><th class="num">saved</th><th class="num">view</th></tr></thead>` +
    `<tbody>${body}</tbody></table>`
  );
}

// ---- latest rendered image ------------------------------------------------

export interface LatestFragmentInput {
  payload: RecentPayload;
  /** pinned image id, or null to follow the latest render */
  pin: number | null;
  /** render the source-text pane inline */
  showSource: boolean;
  /** resolved source text for the displayed image; null = not captured */
  sourceText: string | null;
}

export function renderLatestFragment(inp: LatestFragmentInput): string {
  const { payload, pin, showSource, sourceText } = inp;
  const hasPreview = payload.has_preview === true;
  const meta = payload.preview_meta ?? '';
  const imageIds = payload.image_ids ?? [];
  const pinnedEvicted = pin != null && !imageIds.includes(pin);

  let viewer: string;
  if (pin != null) {
    viewer =
      `<div class="pin-bar"><button class="back-btn" type="button" onclick="ppPin(null)">&larr; latest</button></div>` +
      (pinnedEvicted
        ? `<div class="evicted">(image #${pin} no longer in buffer)</div>`
        : `<div class="preview-crop"><img src="/proxy-latest-png?id=${pin}" alt="image #${pin}" /></div>`);
  } else if (hasPreview) {
    viewer = `<div class="preview-crop"><img src="/proxy-latest-png?t=${encodeURIComponent(meta)}" alt="latest rendered" /></div>`;
  } else {
    viewer = `<div class="sub">(none yet)</div>`;
  }

  const caption = pin != null ? `image #${pin}` : meta ? escapeHtml(meta) + ' - showing top-left at native resolution' : '';
  const showBtn = pin != null ? !pinnedEvicted : hasPreview;
  const srcBtn = showBtn
    ? `<button class="src-btn" type="button" onclick="ppSource(${showSource ? 'false' : 'true'})">${showSource ? 'hide source text' : 'view source text'}</button>`
    : '';

  let srcPane = '';
  if (showSource) {
    srcPane =
      sourceText == null
        ? `<div class="evicted">source text not captured for this image</div>`
        : `<pre class="src-pane">${escapeHtml(sourceText)}</pre>`;
  }

  return `<div class="wrap">${viewer}</div><div class="small">${caption} ${srcBtn}</div>${srcPane}`;
}

// ---- sessions bar chart ---------------------------------------------------

const TOP_N = 8;

export function renderSessionsFragment(p: SessionsPayload): string {
  const all = p.sessions ?? [];
  const rows = [...all]
    .sort((a, b) => (b.tokensSavedEst ?? 0) - (a.tokensSavedEst ?? 0))
    .slice(0, TOP_N);
  const max = rows.reduce((m, s) => Math.max(m, s.tokensSavedEst ?? 0), 0);

  const label = (s: SessionRow) => {
    const proj = s.claudeCode?.projectPath || s.project;
    return proj ? shortPath(proj) : s.id.slice(0, 8);
  };
  const barPct = (v: number) => (max <= 0 || v <= 0 ? 0 : (v / max) * 100);

  const status = `<div class="status">${all.length} session${all.length === 1 ? '' : 's'}</div>`;
  if (rows.length === 0) return status + `<div class="empty">no sessions yet</div>`;

  const chart = rows
    .map((s) => {
      const v = s.tokensSavedEst ?? 0;
      const pct = barPct(v);
      const fill = pct > 0 ? `<div class="fill" style="width:max(3px,${pct}%)"></div>` : '';
      return (
        `<div class="bar-row">` +
        `<div class="blabel" title="${escapeHtml(s.claudeCode?.projectPath || s.project || s.id)}">${escapeHtml(label(s))}</div>` +
        `<div class="track">${fill}</div>` +
        `<div class="bvalue${v < 0 ? ' neg' : ''}">${numFmt(v)}</div>` +
        `</div>`
      );
    })
    .join('');

  return (
    status +
    `<div class="chart">${chart}</div>` +
    `<div class="axis">input tokens saved (cache-aware) &middot; top ${rows.length} of ${all.length}</div>`
  );
}

// ---- full-history stats table ---------------------------------------------

export function renderStatsTableFragment(p: FullStatsPayload): string {
  if (p.error || !p.summary) {
    return `<div class="status">${escapeHtml(p.error || 'no data')}</div><table><tbody></tbody></table>`;
  }
  const s = p.summary;
  const totalIn = (s.inputTokensTotal || 0) + (s.cacheCreateTokensTotal || 0) + (s.cacheReadTokensTotal || 0);
  const hitRateTok = totalIn > 0 ? ((s.cacheReadTokensTotal / totalIn) * 100).toFixed(1) + '%' : '-';
  const hitRateEv =
    s.eventsWithBaseline > 0 ? ((s.cacheHitEvents / s.eventsWithBaseline) * 100).toFixed(1) + '%' : '-';
  const charRatio =
    s.origCharsTotal > 0 ? ((s.imageBytesTotal / s.origCharsTotal) * 100).toFixed(3) + 'x' : '-';

  const tr = (k: string, v: string) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`;
  return (
    `<div class="status">${numFmt(p.parsed)} events parsed</div>` +
    `<table><tbody>` +
    tr('requests', numFmt(s.total)) +
    tr('2xx / 4xx / 5xx', `${numFmt(s.ok2xx)} / ${numFmt(s.err4xx)} / ${numFmt(s.err5xx)}`) +
    tr('compressed', numFmt(s.compressed)) +
    tr('passthrough', numFmt(s.passthrough)) +
    tr('input tokens', numFmt(s.inputTokensTotal)) +
    tr('cache create', numFmt(s.cacheCreateTokensTotal)) +
    tr('cache read', numFmt(s.cacheReadTokensTotal)) +
    tr('cache hit (tok)', hitRateTok) +
    tr('cache hit (ev)', hitRateEv) +
    tr('orig chars', numFmt(s.origCharsTotal)) +
    tr('image bytes', numFmt(s.imageBytesTotal)) +
    tr('bytes/char', charRatio) +
    tr('latency p50/p95', `${numFmt(s.durationP50)} / ${numFmt(s.durationP95)} ms`) +
    tr('first-byte p50/p95', `${numFmt(s.firstByteP50)} / ${numFmt(s.firstByteP95)} ms`) +
    `</tbody></table>`
  );
}

// ---- page shell -------------------------------------------------------------

const CSS = `
  body { margin: 0; padding: 24px; background: #0d1117; color: #c9d1d9;
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, 'SF Mono', Menlo, monospace; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: #3fb950; margin-right: 6px; vertical-align: middle; animation: pulse 2s infinite; }
  @keyframes pulse { 50% { opacity: 0.4; } }
  .sub { color: #8b949e; font-size: 12px; margin-bottom: 22px; }
  .row { display: grid; grid-template-columns: 2fr 1fr; gap: 14px; margin-bottom: 22px; }
  @media (max-width: 1200px) { .row { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 900px) { .row { grid-template-columns: 1fr; } }
  .panel { background: #161b22; border: 1px solid #30363d; border-radius: 10px;
    padding: 14px 16px; min-width: 0; }
  .panel h2 { font-size: 13px; font-weight: 600; margin: 0 0 14px; text-transform: uppercase;
    letter-spacing: 0.08em; color: #8b949e; }
  .small { font-size: 11px; color: #6e7681; margin-top: 4px; }
  .muted { color: #6e7681; }

  /* toggle */
  .banner { display: inline-block; margin: 8px 0; padding: 10px 14px; background: #21262d;
    border: 1px solid #f85149; border-radius: 6px; color: #f85149; font-size: 12px; }
  .toggle-wrap { margin-bottom: 14px; display: flex; align-items: center; gap: 10px; }
  .toggle { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 6px 12px;
    cursor: pointer; border-radius: 6px; font: inherit; font-size: 12px; }
  .toggle:disabled { opacity: 0.5; cursor: wait; }
  .hint { color: #6e7681; font-size: 11px; }

  /* compress-scope chips */
  .models-wrap { margin: -6px 0 14px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .models-label { color: #8b949e; font-size: 12px; }
  .chip { background: #21262d; color: #8b949e; border: 1px solid #30363d; border-radius: 12px;
    padding: 3px 11px; cursor: pointer; font: inherit; font-size: 12px; }
  .chip:hover { border-color: #6e7681; color: #c9d1d9; }
  .chip.on { background: rgba(31,111,235,0.2); color: #58a6ff; border-color: #1f6feb; }

  /* context map */
  .ctxmap { margin: 6px 0 16px; padding: 10px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; }
  .ctxmap-head { font-size: 13px; color: #c9d1d9; margin-bottom: 4px; }
  .rec-view { color: #58a6ff; text-decoration: underline; cursor: pointer; }
  .rec-view:hover { color: #79c0ff; }
  .ctxmap-imgs-title { font-size: 11px; color: #6e7681; margin: 8px 0 4px; }
  .ctxmap-imgs { display: flex; flex-wrap: wrap; gap: 4px; max-height: 460px; overflow: auto;
    background: #fff; padding: 4px; border: 1px solid #30363d; border-radius: 4px; }
  .ctxmap-img { height: 150px; width: auto; max-width: 260px; object-fit: contain; object-position: top left;
    image-rendering: pixelated; background: #fff; border: 1px solid #d0d7de; }
  .ctxmap-img.img-gone { width: 150px; height: 60px; background: #161b22; border: 1px dashed #30363d;
    color: #6e7681; font-size: 10px; }
  .ctxmap-pct { color: #3fb950; font-weight: 600; }
  .ctxmap-sub { font-size: 11px; color: #8b949e; margin: 6px 0 4px; }
  .ctxmap-row { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; padding: 3px 0; border-bottom: 1px solid #161b22; }
  .ctxmap-lbl { color: #8b949e; }
  .ctxmap-val { color: #c9d1d9; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .ctxmap-foot { margin-top: 6px; }

  /* session summary */
  #frag-session .line { font-size: 14px; color: #c9d1d9; margin-bottom: 12px; padding: 8px 12px;
    background: #161b22; border: 1px solid #30363d; border-radius: 6px; }
  #frag-session .label { font-weight: 600; color: #8b949e; letter-spacing: 0.04em; }
  #frag-session .num { font-variant-numeric: tabular-nums; color: #3fb950; font-weight: 600; }

  /* stats header cards */
  .grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 14px; margin-bottom: 22px; }
  @media (max-width: 1400px) { .grid { grid-template-columns: repeat(3, 1fr); } }
  @media (max-width: 900px) { .grid { grid-template-columns: repeat(2, 1fr); } }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 14px 16px; }
  .card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
    color: #8b949e; margin-bottom: 10px; }
  .value { font-size: 24px; font-weight: 600; color: #e6edf3; font-variant-numeric: tabular-nums; }
  .value.pos { color: #3fb950; } .value.neg { color: #f85149; }
  .value.small-sample { color: #8b949e; font-size: 18px; font-weight: 500; }
  details.math { margin-top: 10px; font-size: 11px; }
  details.diagnostic { margin: 0 0 22px; font-size: 12px; color: #8b949e; }
  details summary { cursor: pointer; user-select: none; color: #58a6ff; }
  details summary::-webkit-details-marker { display: none; }
  details summary::before { content: '\\25B8 '; color: #6e7681; font-size: 9px; }
  details[open] summary::before { content: '\\25BE '; }
  details summary:hover { color: #79c0ff; }
  details.diagnostic summary { padding: 6px 0; }
  .formula { background: #0d1117; border: 1px solid #21262d; border-radius: 6px; padding: 8px 10px;
    margin-top: 6px; font: 11px/1.5 'SF Mono', Menlo, monospace; color: #c9d1d9;
    white-space: pre-wrap; word-break: break-word; }
  .formula .k { color: #8b949e; } .formula .v { color: #e6edf3; } .formula .op { color: #f0883e; }
  .formula .src { color: #6e7681; font-size: 10px; display: block; margin-top: 6px;
    border-top: 1px solid #21262d; padding-top: 6px; }
  .diag-headline { color: #c9d1d9; margin-bottom: 8px; }
  .diag-headline .pos { color: #3fb950; font-weight: 600; }
  .diag-headline .neg { color: #f85149; font-weight: 600; }

  /* tables (recent + stats) */
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; color: #6e7681; font-weight: 500; padding: 6px 8px;
    border-bottom: 1px solid #30363d; }
  td { padding: 6px 8px; border-bottom: 1px solid #21262d; font-variant-numeric: tabular-nums;
    vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  th.num, td.num { text-align: right; }
  td.good { color: #3fb950; } td.warn { color: #d29922; } td.bad { color: #f85149; }
  td.pos { color: #3fb950; }
  .thumb-strip { display: flex; gap: 3px; align-items: center; justify-content: flex-end; }
  .thumb-btn { padding: 0; border: 1px solid #30363d; border-radius: 3px; background: #fff;
    cursor: pointer; line-height: 0; }
  .thumb-btn:hover, .thumb-btn:focus-visible { border-color: #58a6ff; outline: none; }
  .thumb { height: 28px; width: auto; max-width: 28px; object-fit: cover;
    object-position: top left; display: block; image-rendering: pixelated; }
  .img-cell { text-align: right; }

  /* latest image viewer */
  .preview-crop { width: 100%; height: 400px; overflow: hidden; background: #fff;
    border: 1px solid #30363d; border-radius: 4px; padding: 4px; box-sizing: border-box; }
  .preview-crop img { display: block; width: auto; height: auto; max-width: none;
    image-rendering: pixelated; }
  .pin-bar { margin-bottom: 8px; }
  .back-btn, .src-btn { font-size: 11px; background: #21262d; color: #58a6ff;
    border: 1px solid #30363d; border-radius: 4px; padding: 2px 8px; cursor: pointer; }
  .src-btn { padding: 1px 6px; margin-left: 8px; }
  .back-btn:hover, .src-btn:hover { background: #30363d; }
  .src-pane { margin-top: 8px; max-height: 400px; overflow: auto; background: #161b22;
    border: 1px solid #30363d; border-radius: 4px; padding: 8px; font-size: 11px;
    line-height: 1.4; white-space: pre-wrap; word-break: break-word; color: #c9d1d9; }
  .evicted { font-size: 11px; color: #6e7681; padding: 12px 0; }

  /* sessions chart */
  .status { margin-bottom: 12px; color: #6e7681; font-size: 12px; }
  .chart { display: flex; flex-direction: column; gap: 8px; }
  .bar-row { display: flex; align-items: center; gap: 10px; font-size: 12px; }
  .blabel { width: 132px; flex: none; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; color: #c9d1d9; }
  .track { flex: 1; min-width: 0; height: 14px; background: #21262d; border-radius: 3px;
    overflow: hidden; }
  .fill { height: 100%; background: #3fb950; border-radius: 3px; }
  .bvalue { width: 72px; flex: none; text-align: right; font-variant-numeric: tabular-nums;
    color: #3fb950; }
  .bvalue.neg { color: #f85149; }
  .axis { margin-top: 12px; color: #6e7681; font-size: 11px; }
  .empty { text-align: center; color: #6e7681; padding: 24px; font-size: 12px; }

  /* toast tray (Alpine) */
  .tray { position: fixed; bottom: 16px; right: 16px; display: flex; flex-direction: column;
    gap: 8px; z-index: 1000; pointer-events: none; }
  .toast { background: #21262d; color: #f85149; border: 1px solid #f85149; border-radius: 6px;
    padding: 10px 14px; font-size: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    display: flex; align-items: center; gap: 12px; pointer-events: auto; max-width: 360px; }
  .toast button { background: transparent; color: inherit; border: 0; cursor: pointer;
    font-size: 16px; line-height: 1; padding: 0; }
`;

// Glue between htmx swaps and the page's two bits of client state:
//   - window.pp: image-pin + source-pane state, sent to /fragments/latest as
//     query params via hx-vals (evaluated at request time). ppPin/ppSource
//     mutate it and force an immediate refresh instead of waiting for the
//     next 2s tick.
//   - <details> open state: htmx innerHTML swaps would close every
//     "show calculation" panel on each poll; record open ids before the swap
//     and restore them after.
//   - toasts: htmx request errors are pushed into the Alpine tray.
const GLUE_JS = `
  window.pp = { pin: null, src: false };
  function ppPin(id) {
    window.pp.pin = id;
    htmx.trigger('#frag-latest', 'pp-refresh');
  }
  function ppSource(on) {
    window.pp.src = on;
    htmx.trigger('#frag-latest', 'pp-refresh');
  }
  document.body.addEventListener('htmx:beforeSwap', function (ev) {
    const open = [];
    ev.detail.target.querySelectorAll('details[open][id]').forEach(function (d) { open.push(d.id); });
    ev.detail.target.__ppOpen = open;
  });
  document.body.addEventListener('htmx:afterSwap', function (ev) {
    (ev.detail.target.__ppOpen || []).forEach(function (id) {
      const d = document.getElementById(id);
      if (d) d.setAttribute('open', '');
    });
  });
  document.body.addEventListener('htmx:responseError', function (ev) {
    window.dispatchEvent(new CustomEvent('pp-toast', {
      detail: { text: ev.detail.xhr.status + ' ' + ev.detail.requestConfig.path }
    }));
  });
  document.body.addEventListener('htmx:sendError', function (ev) {
    window.dispatchEvent(new CustomEvent('pp-toast', {
      detail: { text: 'proxy unreachable: ' + ev.detail.requestConfig.path }
    }));
  });
`;

export function renderPage(port: number): string {
  // Each fragment div polls its own endpoint. `hx-trigger="load, every Ns"`
  // paints immediately on page load, then keeps the legacy cadence
  // (2s live counters, 5s slow aggregates).
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>pxpipe - live dashboard</title>
<style>${CSS}</style>
</head>
<body>
<h1><span class="dot"></span>pxpipe</h1>

<div id="frag-toggle" hx-get="/fragments/toggle" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>
<div id="frag-models" hx-get="/fragments/models" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>
<div id="frag-session" hx-get="/fragments/session-summary" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>
<div id="frag-header" hx-get="/fragments/header" hx-trigger="load, every 2s" hx-swap="innerHTML"><div class="sub">connecting&hellip;</div></div>

<div class="row">
  <div class="panel">
    <h2>recent requests</h2>
    <div id="frag-context-map" hx-get="/fragments/context-map" hx-trigger="load" hx-swap="innerHTML"></div>
    <div id="frag-recent" hx-get="/fragments/recent" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>
  </div>
  <div class="panel">
    <h2>latest rendered image</h2>
    <div id="frag-latest" hx-get="/fragments/latest" hx-trigger="load, every 2s, pp-refresh" hx-swap="innerHTML"
         hx-vals='js:{pin: window.pp.pin == null ? "" : window.pp.pin, source: window.pp.src ? "1" : ""}'></div>
  </div>
</div>

<div class="panel" style="margin-bottom:22px">
  <h2>sessions <span class="small" style="color:#6e7681">(top savers)</span></h2>
  <div id="frag-sessions" hx-get="/fragments/sessions" hx-trigger="load, every 5s" hx-swap="innerHTML"></div>
</div>

<div class="panel" style="margin-bottom:22px">
  <h2>stats <span class="small" style="color:#6e7681">(full history)</span></h2>
  <div id="frag-stats" hx-get="/fragments/stats" hx-trigger="load, every 5s" hx-swap="innerHTML"></div>
</div>

<div class="tray" x-data="{ toasts: [], next: 1 }"
     @pp-toast.window="const id = next++; toasts.push({ id, text: $event.detail.text }); setTimeout(() => toasts = toasts.filter(t => t.id !== id), 5000)">
  <template x-for="t in toasts" :key="t.id">
    <div class="toast"><span x-text="t.text"></span><button type="button" @click="toasts = toasts.filter(x => x.id !== t.id)" aria-label="dismiss">&times;</button></div>
  </template>
</div>

<script>${HTMX_JS}</script>
<script>${GLUE_JS}</script>
<script>${ALPINE_JS}</script>
</body>
</html>`;
}
