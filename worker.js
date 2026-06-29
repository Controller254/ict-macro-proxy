const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const NEWS_SOURCES = [
  "https://www.cnbc.com/id/100003114/device/rss/rss.html",
  "https://feeds.content.dowjones.io/public/rss/mw_topstories",
  "https://www.investing.com/rss/news_301.rss",
];

let calendarCache = { data: null, fetchedAt: 0 };
const CALENDAR_CACHE_MS = 5 * 60 * 1000;

// NOTE: COT caching now lives in Workers KV (env.COT_KV), NOT a module-level
// variable. Cloudflare Workers are stateless across invocations — a plain
// JS variable like `let cotCache = {...}` only survives within a single
// isolate, and Cloudflare may route different requests to different
// isolates (or evict/recreate an isolate) at any time with no warning.
// That meant our in-memory cache was silently useless for most requests:
// the "TEST WORKER CONNECTION" button could hit a fresh isolate that
// happened to reach CFTC successfully, while the next real request from
// the terminal hit a DIFFERENT isolate with an empty cache, retried CFTC
// fresh, hit CFTC's intermittent WAF rejection again, and surfaced a 502
// to the user — even though "the worker is definitely fetching CFTC fine"
// from the dashboard's point of view a moment earlier.
// Workers KV is real durable storage shared across all isolates, so once
// ANY request succeeds, every other invocation — anywhere — sees the
// cached data immediately. This is the actual fix for the 502s, not just
// the retry/backoff logic below (which still helps for cold-cache misses).
const COT_CACHE_KEY = "cot_latest";
const COT_CACHE_MS = 60 * 60 * 1000; // COT updates once a week (Fri), 1hr cache is plenty

const OPEX_CACHE_KEY = "opex_latest";
const OPEX_CACHE_MS = 60 * 60 * 1000; // OPEX updates daily — 1hr cache, manual updates via PUT /opex/update

// CFTC's Traders in Financial Futures (TFF) dataset, Socrata Open Data API.
// Free, public, no key, no login - government open data.
// https://publicreporting.cftc.gov/Commitments-of-Traders/TFF-Futures-Only/gpe5-46if
const CFTC_TFF_URL = "https://publicreporting.cftc.gov/resource/gpe5-46if.json";

// Maps our terminal's symbols to CFTC's "Market_and_Exchange_Names" text.
// CFTC uses full descriptive names, not tickers, so we match by substring.
const COT_SYMBOL_MAP = {
  EURUSD: "EURO FX",
  GBPUSD: "BRITISH POUND",
  USDJPY: "JAPANESE YEN",
  AUDUSD: "AUSTRALIAN DOLLAR",
  USDCAD: "CANADIAN DOLLAR",
  USDCHF: "SWISS FRANC",
  NZDUSD: "NEW ZEALAND DOLLAR",
  DXY: "USD INDEX",
  NAS100: "NASDAQ-100",
  SP500: "E-MINI S&P 500",
  // BUG FIX: "DOW JONES" alone also matches "DOW JONES U.S. REAL ESTATE IDX"
  // (CFTC code #124606), which sorts ahead of the actual DJIA futures
  // (#124603) in many result sets — confirmed against CFTC's own published
  // financial futures reports, where both contracts literally start with
  // "DOW JONES". The needle must be specific enough to exclude Real Estate.
  US30: "DOW JONES INDUSTRIAL AVG",
  US10Y: "10-YEAR U.S. TREASURY NOTES",
  US30Y: "ULTRA U.S. TREASURY BONDS",
  // NOTE: XAUUSD/XAGUSD removed from here — gold and silver are physical
  // commodities, not financial futures, so they structurally cannot appear
  // in the TFF (Traders in Financial Futures) dataset this map queries.
  // They silently matched nothing before. See DISAGG_SYMBOL_MAP below,
  // which queries the correct CFTC dataset (Disaggregated Futures-Only)
  // for these two.
};

// CFTC's Disaggregated Futures-Only dataset, Socrata Open Data API.
// This is the correct dataset for physical commodities (metals, energy,
// ag) — TFF above only covers financial futures (currencies, rates,
// equity indices) and structurally never includes Gold/Silver.
// https://publicreporting.cftc.gov/Commitments-of-Traders/Disaggregated-Futures-Only/72hh-3qpy
const CFTC_DISAGG_URL = "https://publicreporting.cftc.gov/resource/72hh-3qpy.json";

// EXACT contract names (verified live via /disagg-debug on 2026-06-28) — NOT
// substring needles. CFTC also lists "MICRO GOLD - COMMODITY EXCHANGE INC."
// and "MICRO SILVER - COMMODITY EXCHANGE INC.", and a substring match for
// "GOLD - COMMODITY EXCHANGE INC" would ALSO match inside "MICRO GOLD - ...".
// in the exact same way "DOW JONES" matched the wrong contract above. We use
// exact equality here instead of indexOf to rule that out structurally.
const DISAGG_EXACT_NAMES = {
  XAUUSD: "GOLD - COMMODITY EXCHANGE INC.",
  XAGUSD: "SILVER - COMMODITY EXCHANGE INC.",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }
    try {
      if (url.pathname === "/calendar") {
        return await proxyCalendar();
      }
      if (url.pathname === "/news") {
        return await proxyNews();
      }
      if (url.pathname === "/cot") {
        return await proxyCot(env);
      }
      if (url.pathname === "/disagg-debug") {
        return await debugDisagg();
      }
      if (url.pathname === "/stockfg") {
        return await proxyStockFearGreed();
      }
      if (url.pathname === "/opex") {
        return await proxyOpex(env);
      }
      // PUT /opex/update — manually push today's OPEX data from your phone/browser
      // Body: the full OPEX JSON object (see terminal source for shape)
      // Example: curl -X PUT https://your-worker.workers.dev/opex/update -H "Content-Type: application/json" -d '{"asOf":"2026-06-27","source":"investing.com","expiries":[...]}'
      if (url.pathname === "/opex/update" && request.method === "PUT") {
        return await updateOpex(request, env);
      }
      if (url.pathname === "/fxssi-raw") {
        return await fetchFxssiRaw();
      }
      return jsonResponse(
        { error: { message: "Unknown endpoint. Use /calendar, /news, /cot, /stockfg, /opex, /disagg-debug, or PUT /opex/update." } },
        404
      );
    } catch (err) {
      return jsonResponse({ error: { message: "Worker error: " + err.message } }, 500);
    }
  },
};

// ── COT (Commitment of Traders) ──────────────────────────────────────────

// BUG FIX (kept from before): publicreporting.cftc.gov intermittently
// returns 502/503 to requests coming from Cloudflare Workers' shared IP
// ranges (a known pattern — government WAFs and bot-detection on .gov sites
// often reject traffic from cloud-provider IP blocks even though the
// request itself is fine). We retry transient-looking failures (429, 502,
// 503, 504, and network-level fetch throws) up to 3 times with a short
// backoff, and use a realistic full browser User-Agent instead of a
// self-identifying bot UA, since some .gov WAFs specifically allowlist real
// browser UAs. Shared between the TFF and Disaggregated fetches below —
// both hit the exact same CFTC infrastructure and the exact same problem.
const REALISTIC_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TRANSIENT_STATUSES = [429, 502, 503, 504];
const MAX_ATTEMPTS = 3;

async function fetchCftcRowsWithRetry(queryUrl) {
  let res = null;
  let lastError = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetch(queryUrl, {
        headers: { "User-Agent": REALISTIC_UA, Accept: "application/json" },
      });
      lastStatus = res.status;
      if (res.ok) break;
      if (TRANSIENT_STATUSES.indexOf(res.status) === -1) break;
    } catch (err) {
      lastError = err;
      res = null;
    }
    if (attempt < MAX_ATTEMPTS) {
      await sleep(attempt === 1 ? 400 : 900);
    }
  }

  if (!res || !res.ok) {
    const detail = lastError
      ? "network error contacting CFTC: " + lastError.message
      : "CFTC source returned HTTP " + lastStatus + " after " + MAX_ATTEMPTS + " attempts";
    return { rows: null, error: detail, status: lastStatus };
  }

  let rows;
  try {
    rows = await res.json();
  } catch (e) {
    return { rows: null, error: "CFTC source returned unparseable data: " + e.message, status: lastStatus };
  }
  if (!Array.isArray(rows)) {
    return { rows: null, error: "CFTC source returned unexpected shape.", status: lastStatus };
  }
  return { rows, error: null, status: lastStatus };
}

async function proxyCot(env) {
  const now = Date.now();

  // 1. Check KV first — this is durable and shared across ALL isolates,
  //    unlike a module-level variable. If a fresh-enough copy exists here,
  //    serve it immediately with zero CFTC calls.
  const cached = await readCotCache(env);
  if (cached && now - cached.fetchedAt < COT_CACHE_MS) {
    return jsonResponse(cached.data, 200, { "X-Cache": "HIT" });
  }

  // Pull the most recent report for every market in one call, sorted by
  // date descending, then keep only the newest row per market below.
  const orderClause = encodeURIComponent("report_date_as_yyyy_mm_dd DESC");
  const tffUrl = CFTC_TFF_URL + "?$limit=2000&$order=" + orderClause;

  const tffResult = await fetchCftcRowsWithRetry(tffUrl);

  if (!tffResult.rows) {
    // 2. CFTC failed this round — fall back to ANY cached copy we have in
    //    KV, even if it's older than the normal 1hr freshness window.
    //    Stale COT data (positioning from last Friday) is still far more
    //    useful than an error, since COT only updates weekly anyway.
    if (cached && cached.data) {
      return jsonResponse(cached.data, 200, { "X-Cache": "STALE-ON-ERROR" });
    }
    return jsonResponse(
      { error: { message: tffResult.error } },
      tffResult.status && tffResult.status < 500 ? tffResult.status : 502
    );
  }

  const rows = tffResult.rows;

  // Sanity check: confirm rows are actually sorted newest-first now that
  // $order is correctly encoded.
  //
  // FIX: the original 10-day threshold was too tight for reality. Live
  // /cot-debug output on 2026-06-21 showed CFTC's own newest TFF report
  // dated 2026-06-09 — 12 days old — which is NORMAL, not broken: CFTC's
  // Tuesday-data/Friday-publish cadence can slip around holidays, and some
  // less-active contracts simply update less often even when $order is
  // correct. The old code was treating valid, real CFTC data as an error
  // and discarding it, which was the actual cause of the 502s reported by
  // the terminal (the field-name bug below caused 0s, but THIS date check
  // was what made the whole request fail outright).
  //
  // We widen the threshold to 21 days (3 weeks) — generous enough to ride
  // out a holiday-delayed report — and, more importantly, we no longer
  // hard-fail the request over this. A stale-but-real date is still real
  // COT data and far more useful to a trader than an error message. We
  // just flag it for visibility instead.
  const newestDate = rows.length > 0 ? rows[0].report_date_as_yyyy_mm_dd : null;
  let staleWarning = null;
  if (newestDate) {
    const ageMs = now - new Date(newestDate).getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    if (ageDays > 21 || ageDays < -1) {
      staleWarning =
        "Newest CFTC report dated " + newestDate + " (" + Math.round(ageDays) + " days old) — older than usual.";
    }
  }

  const result = {};
  for (const ourSymbol in COT_SYMBOL_MAP) {
    const needle = COT_SYMBOL_MAP[ourSymbol];
    const match = findFirstMatchingRow(rows, needle);
    if (match) {
      result[ourSymbol] = summarizeCotRow(match);
    }
  }

  // ── Gold/Silver — separate CFTC dataset (Disaggregated Futures-Only).
  // Best-effort: if this fails, we still return everything else above
  // rather than failing the whole /cot endpoint over a secondary dataset.
  let disaggError = null;
  try {
    const disaggUrl = CFTC_DISAGG_URL + "?$limit=3000&$order=" + orderClause;
    const disaggResult = await fetchCftcRowsWithRetry(disaggUrl);
    if (disaggResult.rows) {
      for (const ourSymbol in DISAGG_EXACT_NAMES) {
        const exactName = DISAGG_EXACT_NAMES[ourSymbol];
        // Exact match, not substring — see comment on DISAGG_EXACT_NAMES.
        const match = disaggResult.rows.find((r) => r.market_and_exchange_names === exactName);
        if (match) {
          result[ourSymbol] = summarizeDisaggRow(match);
        }
      }
    } else {
      disaggError = disaggResult.error;
    }
  } catch (e) {
    disaggError = "unexpected error fetching Disaggregated dataset: " + e.message;
  }

  const payload = {
    asOf: newestDate,
    markets: result,
    source:
      "https://publicreporting.cftc.gov/Commitments-of-Traders/TFF-Futures-Only/gpe5-46if and " +
      "Disaggregated-Futures-Only/72hh-3qpy (CFTC public API)",
    staleWarning: staleWarning,
    disaggError: disaggError, // null when Gold/Silver fetched fine; otherwise explains why they're missing
  };

  // 3. Persist to KV so every other isolate / future request benefits,
  //    not just this one. Don't let a KV write failure break the response
  //    we already have — log and continue.
  await writeCotCache(env, { data: payload, fetchedAt: now });

  return jsonResponse(payload, 200, { "X-Cache": "MISS" });
}

function summarizeDisaggRow(row) {
  const num = (v) => (v === undefined || v === null || v === "" ? 0 : parseInt(v, 10));

  // Field names confirmed live via /disagg-debug on 2026-06-28. Note the
  // genuine double underscore in "swap__positions_short_all" and
  // "swap__positions_spread_all" — that's CFTC's actual field name, not a
  // typo introduced here. prod_merc and other_rept have NO "_all" suffix;
  // swap and m_money DO. Same lesson as the TFF dealer_positions_long_all
  // bug: the suffix pattern is inconsistent across CFTC's own datasets, so
  // we read exactly what the live API returns rather than what the
  // category names would suggest.
  //
  // "Producer/Merchant/Processor/User" is the closest real analog to
  // "Commercial" for a physical commodity like Gold/Silver — these are the
  // miners, refiners, and bullion dealers hedging actual physical exposure,
  // which is conceptually different from TFF's "Dealer/Intermediary" used
  // for FX (bank market-makers, not physical hedgers).
  const commercialLong = num(row.prod_merc_positions_long);
  const commercialShort = num(row.prod_merc_positions_short);
  const swapLong = num(row.swap_positions_long_all);
  const swapShort = num(row.swap__positions_short_all);
  const moneyMgrLong = num(row.m_money_positions_long_all);
  const moneyMgrShort = num(row.m_money_positions_short_all);
  const otherLong = num(row.other_rept_positions_long);
  const otherShort = num(row.other_rept_positions_short);

  return {
    marketName: row.market_and_exchange_names,
    reportDate: row.report_date_as_yyyy_mm_dd,
    openInterest: num(row.open_interest_all),
    commercial: { long: commercialLong, short: commercialShort, net: commercialLong - commercialShort },
    swapDealers: { long: swapLong, short: swapShort, net: swapLong - swapShort },
    managedMoney: { long: moneyMgrLong, short: moneyMgrShort, net: moneyMgrLong - moneyMgrShort },
    otherReportables: { long: otherLong, short: otherShort, net: otherLong - otherShort },
  };
}

// ── DISAGGREGATED REPORT DEBUG (Gold/Silver field-name verification) ──────
// Same lesson as the TFF dealer_positions_long_all bug: don't trust CFTC's
// documented field names, check what the live API actually returns. This
// queries the Disaggregated Futures-Only dataset, finds the newest Gold and
// Silver rows, and returns their RAW keys/values untouched so we can see
// the real field names before wiring them into /cot permanently.
async function debugDisagg() {
  const orderClause = encodeURIComponent("report_date_as_yyyy_mm_dd DESC");
  const queryUrl = CFTC_DISAGG_URL + "?$limit=3000&$order=" + orderClause;
  const REALISTIC_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

  let res;
  try {
    res = await fetch(queryUrl, { headers: { "User-Agent": REALISTIC_UA, Accept: "application/json" } });
  } catch (e) {
    return jsonResponse({ error: { message: "network error contacting CFTC: " + e.message } }, 502);
  }
  if (!res.ok) {
    return jsonResponse({ error: { message: "CFTC source returned HTTP " + res.status } }, 502);
  }

  const rows = await res.json();
  if (!Array.isArray(rows)) {
    return jsonResponse({ error: { message: "CFTC source returned unexpected shape." } }, 502);
  }

  // Surface every distinct market_and_exchange_names value containing GOLD
  // or SILVER, so we can see the exact contract name strings too (there
  // may be more than one Gold/Silver contract — micro, mini, etc.)
  const matchingNames = new Set();
  let goldRow = null;
  let silverRow = null;
  for (const row of rows) {
    const name = (row.market_and_exchange_names || "").toUpperCase();
    if (name.indexOf("GOLD") !== -1) {
      matchingNames.add(row.market_and_exchange_names);
      if (!goldRow) goldRow = row;
    }
    if (name.indexOf("SILVER") !== -1) {
      matchingNames.add(row.market_and_exchange_names);
      if (!silverRow) silverRow = row;
    }
  }

  return jsonResponse({
    distinctGoldSilverContractNames: Array.from(matchingNames),
    rawGoldRow: goldRow,
    rawSilverRow: silverRow,
    totalRowsFetched: rows.length,
    newestDateInResultSet: rows.length ? rows[0].report_date_as_yyyy_mm_dd : null,
  });
}

async function readCotCache(env) {
  if (!env || !env.COT_KV) return null;
  try {
    const raw = await env.COT_KV.get(COT_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function writeCotCache(env, entry) {
  if (!env || !env.COT_KV) return;
  try {
    // expirationTtl is a belt-and-suspenders cleanup; our own freshness
    // check above (COT_CACHE_MS) is what actually governs HIT vs MISS.
    await env.COT_KV.put(COT_CACHE_KEY, JSON.stringify(entry), {
      expirationTtl: 7 * 24 * 60 * 60, // 7 days
    });
  } catch (e) {
    // Swallow — a failed cache write shouldn't fail the request that
    // already has good data to return to the caller.
  }
}

// ── STOCK FEAR & GREED (CNN Business) ────────────────────────────────────
// CNN's internal API endpoint — returns the current Fear & Greed score and
// rating for the US stock market. Used by the terminal's sentiment card for
// FX/indices bias (separate from the crypto F&G from alternative.me).
// This is undocumented but stable — CNN uses it for their own widget.
async function proxyStockFearGreed() {
  const CNN_FG_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
  try {
    const res = await fetch(CNN_FG_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Referer": "https://www.cnn.com/markets/fear-and-greed",
        "Accept": "application/json, */*",
      },
    });
    if (!res.ok) {
      return jsonResponse({ error: { message: "CNN F&G returned HTTP " + res.status } }, 502);
    }
    const data = await res.json();
    // CNN response shape: { fear_and_greed: { score: 26.1, rating: "fear", ... }, ... }
    const fg = data && data.fear_and_greed;
    if (!fg || fg.score == null) {
      return jsonResponse({ error: { message: "Unexpected CNN F&G response shape" } }, 502);
    }
    return jsonResponse({
      value: Math.round(fg.score),
      rating: fg.rating || "unknown",
      previous_close: fg.previous_close || null,
      previous_1_week: fg.previous_1_week || null,
      timestamp: fg.timestamp || null,
      source: "CNN Business Fear & Greed Index",
    }, 200);
  } catch (err) {
    return jsonResponse({ error: { message: "CNN F&G fetch failed: " + err.message } }, 502);
  }
}

// ── FX OPTIONS EXPIRY (OPEX) ─────────────────────────────────────────────
// OPEX data is updated manually each day by calling PUT /opex/update with
// the day's strike levels (from investing.com/forex-options or @pizzo_fx).
// The data is stored in Workers KV so all terminal instances see it instantly.
// GET /opex returns today's data or the last known data with a staleness flag.
async function proxyOpex(env) {
  try {
    const stored = await readOpexCache(env);
    if (!stored) {
      // No data ever pushed — return a helpful empty state, not an error
      return jsonResponse({
        asOf: null,
        source: null,
        stale: true,
        message: "No OPEX data yet. Use PUT /opex/update to push today's strike levels.",
        expiries: [],
      }, 200);
    }
    const ageMs = Date.now() - (stored.fetchedAt || 0);
    const stale = ageMs > OPEX_CACHE_MS;
    return jsonResponse({ ...stored.data, stale, ageMs }, 200, {
      "X-Cache": stale ? "STALE" : "HIT",
    });
  } catch (err) {
    return jsonResponse({ error: { message: "OPEX read failed: " + err.message } }, 500);
  }
}

// PUT /opex/update — push new OPEX data into KV.
// Called manually from curl/browser once per day with the day's strike levels.
// No auth key required (worker is on your own domain — if you want auth, add
// a secret header check here using env.OPEX_SECRET).
async function updateOpex(request, env) {
  try {
    const body = await request.json();
    if (!body || !Array.isArray(body.expiries)) {
      return jsonResponse({ error: { message: "Body must be JSON with an 'expiries' array." } }, 400);
    }
    // Stamp with server time if asOf not provided
    if (!body.asOf) {
      body.asOf = new Date().toISOString().slice(0, 10);
    }
    await writeOpexCache(env, body);
    return jsonResponse({
      ok: true,
      asOf: body.asOf,
      pairs: body.expiries.map(function(e) { return e.pair; }),
      message: "OPEX data stored. Terminal will show updated levels on next /opex fetch.",
    }, 200);
  } catch (err) {
    return jsonResponse({ error: { message: "OPEX update failed: " + err.message } }, 500);
  }
}

async function readOpexCache(env) {
  try {
    if (!env || !env.COT_KV) return null; // reuse same KV binding
    const raw = await env.COT_KV.get(OPEX_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

async function writeOpexCache(env, data) {
  if (!env || !env.COT_KV) return;
  await env.COT_KV.put(OPEX_CACHE_KEY, JSON.stringify({ data, fetchedAt: Date.now() }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Each market reports weekly, so with 500 rows ordered newest-first we may
// not have reached every market's most recent row yet if many markets sort
// ahead of it alphabetically/by-id for that date. Searching only the first
// match by substring (without also requiring it be from the newest date)
// risked matching an older row for less commonly-referenced markets. We
// widened $limit to 2000 above; this raises the matched needle further to
// also prefer rows dated on/near the newest date when multiple matches exist.
function findFirstMatchingRow(rows, needle) {
  const upperNeedle = needle.toUpperCase();
  let firstMatch = null;
  const newestDate = rows.length > 0 ? rows[0].report_date_as_yyyy_mm_dd : null;
  for (let i = 0; i < rows.length; i++) {
    const name = rows[i].market_and_exchange_names || "";
    if (name.toUpperCase().indexOf(upperNeedle) !== -1) {
      if (!firstMatch) firstMatch = rows[i];
      // Prefer an exact newest-date match if we find one
      if (newestDate && rows[i].report_date_as_yyyy_mm_dd === newestDate) {
        return rows[i];
      }
    }
  }
  return firstMatch;
}

function summarizeCotRow(row) {
  const num = (v) => (v === undefined || v === null || v === "" ? 0 : parseInt(v, 10));

  // FIX: CFTC's actual JSON field names for these two categories do NOT
  // have an "_all" suffix (confirmed via live /cot-debug response on
  // 2026-06-21 — x-soda2-fields lists "asset_mgr_positions_long" and
  // "lev_money_positions_long", not "..._long_all"). Only dealer_* and
  // open_interest_all carry the _all suffix. Reading the wrong field name
  // silently returned undefined -> 0 for every market's asset manager and
  // leveraged funds positioning, which is the data ICT traders actually
  // care about most (the "smart money" proxy).
  const assetMgrLong = num(row.asset_mgr_positions_long);
  const assetMgrShort = num(row.asset_mgr_positions_short);
  const levMoneyLong = num(row.lev_money_positions_long);
  const levMoneyShort = num(row.lev_money_positions_short);
  const dealerLong = num(row.dealer_positions_long_all);
  const dealerShort = num(row.dealer_positions_short_all);

  return {
    marketName: row.market_and_exchange_names,
    reportDate: row.report_date_as_yyyy_mm_dd,
    openInterest: num(row.open_interest_all),
    assetManager: { long: assetMgrLong, short: assetMgrShort, net: assetMgrLong - assetMgrShort },
    leveragedFunds: { long: levMoneyLong, short: levMoneyShort, net: levMoneyLong - levMoneyShort },
    dealer: { long: dealerLong, short: dealerShort, net: dealerLong - dealerShort },
  };
}

// ── CALENDAR ──────────────────────────────────────────────────────────────
async function proxyCalendar() {
  const now = Date.now();
  if (calendarCache.data && now - calendarCache.fetchedAt < CALENDAR_CACHE_MS) {
    return jsonResponse(calendarCache.data, 200, { "X-Cache": "HIT" });
  }
  const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
    },
  });
  if (!res.ok) {
    if (calendarCache.data) {
      return jsonResponse(calendarCache.data, 200, { "X-Cache": "STALE-ON-ERROR" });
    }
    return jsonResponse({ error: { message: "Calendar source returned " + res.status } }, 502);
  }
  const text = await res.text();
  const looksLikeHtml = /^\s*<(!doctype|html)/i.test(text);
  if (looksLikeHtml) {
    if (calendarCache.data) {
      return jsonResponse(calendarCache.data, 200, { "X-Cache": "STALE-RATE-LIMITED" });
    }
    return jsonResponse({ error: { message: "Calendar source rate-limited this Worker. Try again shortly." } }, 429);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    if (calendarCache.data) {
      return jsonResponse(calendarCache.data, 200, { "X-Cache": "STALE-PARSE-ERROR" });
    }
    return jsonResponse({ error: { message: "Calendar source returned unparseable data: " + e.message } }, 502);
  }
  if (!Array.isArray(data)) {
    if (calendarCache.data) {
      return jsonResponse(calendarCache.data, 200, { "X-Cache": "STALE-SHAPE-ERROR" });
    }
    return jsonResponse({ error: { message: "Calendar source returned unexpected shape." } }, 502);
  }
  calendarCache = { data: data, fetchedAt: now };
  return jsonResponse(data, 200, { "X-Cache": "MISS" });
}

// ── NEWS ──────────────────────────────────────────────────────────────────
async function proxyNews() {
  const errors = [];
  for (let i = 0; i < NEWS_SOURCES.length; i++) {
    const sourceUrl = NEWS_SOURCES[i];
    try {
      const res = await fetch(sourceUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "application/rss+xml, application/xml, text/xml, */*",
        },
      });
      if (!res.ok) {
        errors.push(sourceUrl + " -> HTTP " + res.status);
        continue;
      }
      const xml = await res.text();
      const items = parseRssItems(xml);
      if (items.length > 0) {
        return jsonResponse({ items: items, source: sourceUrl }, 200);
      }
      errors.push(sourceUrl + " -> parsed 0 items");
    } catch (err) {
      errors.push(sourceUrl + " -> " + err.message);
    }
  }
  return jsonResponse({ error: { message: "All news sources failed: " + errors.join(" | ") } }, 502);
}

function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  const limit = Math.min(itemBlocks.length, 10);
  for (let i = 0; i < limit; i++) {
    const block = itemBlocks[i];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    if (title) {
      items.push({
        title: decodeEntities(stripCdata(title)),
        link: link ? decodeEntities(stripCdata(link)).trim() : "",
      });
    }
  }
  return items;
}

function extractTag(block, tag) {
  const re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "i");
  const m = block.match(re);
  return m ? m[1] : "";
}

function stripCdata(s) {
  return s.replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim();
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// ── FXSSI DEBUG (kept for now, harmless) ───────────────────────────────────
async function fetchFxssiRaw() {
  const res = await fetch("https://fxssi.com/tools/current-ratio", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  const html = await res.text();
  return jsonResponse({ status: res.status, htmlLength: html.length }, 200);
}

// ── HELPERS ──────────────────────────────────────────────────────────────
function jsonResponse(body, status, extraHeaders) {
  const headers = { "Content-Type": "application/json" };
  for (const k in CORS_HEADERS) {
    headers[k] = CORS_HEADERS[k];
  }
  if (extraHeaders) {
    for (const k in extraHeaders) {
      headers[k] = extraHeaders[k];
    }
  }
  return new Response(JSON.stringify(body), { status: status, headers: headers });
}
