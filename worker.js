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

// CFTC's Traders in Financial Futures (TFF) dataset, Socrata Open Data API.
// Free, public, no key, no login - government open data.
// https://publicreporting.cftc.gov/Commitments-of-Traders/TFF-Futures-Only/gpe5-46if
const CFTC_TFF_URL = "https://publicreporting.cftc.gov/resource/gpe5-46if.json";

// Maps our terminal's symbols to CFTC's "Market_and_Exchange_Names" text.
// CFTC uses full descriptive names, not tickers, so we match by substring.
// IMPORTANT: CFTC publishes BOTH standalone currency futures (e.g. "EURO FX")
// AND separate cross-rate contracts (e.g. "EURO FX/JAPANESE YEN XRATE"). A
// plain substring match on "JAPANESE YEN" matches the EUR/JPY cross-rate
// contract too — and since that row often sorts earlier, it was winning by
// mistake for both EURUSD and USDJPY. findFirstMatchingRow() now skips any
// market name containing "/" or "XRATE" so only the real standalone
// currency futures (CME codes 6E, 6B, 6J, 6A, 6C, 6S, 6N) can match.
const COT_SYMBOL_MAP = {
  EURUSD: "EURO FX",
  GBPUSD: "BRITISH POUND STERLING",
  USDJPY: "JAPANESE YEN",
  AUDUSD: "AUSTRALIAN DOLLAR",
  USDCAD: "CANADIAN DOLLAR",
  USDCHF: "SWISS FRANC",
  NZDUSD: "NEW ZEALAND DOLLAR",
  DXY: "USD INDEX",
  NAS100: "NASDAQ-100 STOCK INDEX",
  SP500: "S&P 500 STOCK INDEX",
  US30: "DOW JONES INDUSTRIAL AVG",
  US10Y: "10-YEAR U.S. TREASURY NOTES",
  US30Y: "ULTRA U.S. TREASURY BONDS",
  XAUUSD: "GOLD",
  XAGUSD: "SILVER",
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
      if (url.pathname === "/cot-debug") {
        return await debugCot();
      }
      if (url.pathname === "/fxssi-raw") {
        return await fetchFxssiRaw();
      }
      return jsonResponse(
        { error: { message: "Unknown endpoint. Use /calendar, /news, /cot, /cot-debug, or /fxssi-raw." } },
        404
      );
    } catch (err) {
      return jsonResponse({ error: { message: "Worker error: " + err.message } }, 500);
    }
  },
};

// ── TEMPORARY DIAGNOSTIC — surfaces the EXACT raw response CFTC gives this
// Worker right now: status, key headers, and the first chunk of body text.
// This exists purely to identify why /cot is returning 502 — once we know
// the real cause (WAF block page, rate-limit message, different error,
// etc.) this endpoint can be deleted. Visit /cot-debug directly in a
// browser tab to see the output.
async function debugCot() {
  const REALISTIC_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
  const orderClause = encodeURIComponent("report_date_as_yyyy_mm_dd DESC");
  const queryUrl = CFTC_TFF_URL + "?$limit=5&$order=" + orderClause;
  try {
    const res = await fetch(queryUrl, {
      headers: { "User-Agent": REALISTIC_UA, Accept: "application/json" },
    });
    const text = await res.text();
    const headersObj = {};
    res.headers.forEach((v, k) => {
      headersObj[k] = v;
    });
    return jsonResponse(
      {
        requestedUrl: queryUrl,
        status: res.status,
        statusText: res.statusText,
        responseHeaders: headersObj,
        bodyPreview: text.slice(0, 800),
        bodyLength: text.length,
      },
      200
    );
  } catch (err) {
    return jsonResponse(
      { requestedUrl: queryUrl, networkError: err.message, networkErrorName: err.name },
      200
    );
  }
}

// ── COT (Commitment of Traders) ──────────────────────────────────────────
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
  const queryUrl = CFTC_TFF_URL + "?$limit=2000&$order=" + orderClause;

  // BUG FIX: publicreporting.cftc.gov intermittently returns 502/503 to
  // requests coming from Cloudflare Workers' shared IP ranges (this is a
  // known pattern — government WAFs and bot-detection on .gov sites often
  // reject traffic from cloud-provider IP blocks even though the request
  // itself is fine). A single failed attempt was being treated as a hard
  // failure with no retry, even though a second attempt moments later
  // frequently succeeds. We now retry transient-looking failures (502,
  // 503, 504, and network-level fetch throws) up to 3 times with a short
  // backoff before giving up. We also use a realistic full browser User-
  // Agent string instead of a generic "compatible; ICT-Terminal-Worker/1.0"
  // identifier, since some .gov WAFs specifically allowlist real browser
  // UAs and challenge or reject anything that self-identifies as a bot.
  const REALISTIC_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
  const TRANSIENT_STATUSES = [429, 502, 503, 504];
  const MAX_ATTEMPTS = 3;

  let res = null;
  let lastError = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetch(queryUrl, {
        headers: {
          "User-Agent": REALISTIC_UA,
          Accept: "application/json",
        },
      });
      lastStatus = res.status;
      if (res.ok) break; // success, stop retrying
      if (TRANSIENT_STATUSES.indexOf(res.status) === -1) break; // non-transient, no point retrying
    } catch (err) {
      lastError = err;
      res = null;
    }
    if (attempt < MAX_ATTEMPTS) {
      // Short backoff: 400ms, then 900ms. Workers have a CPU-time budget,
      // so we keep this brief rather than a long exponential wait.
      await sleep(attempt === 1 ? 400 : 900);
    }
  }

  if (!res || !res.ok) {
    // 2. CFTC failed this round — fall back to ANY cached copy we have in
    //    KV, even if it's older than the normal 1hr freshness window.
    //    Stale COT data (positioning from last Friday) is still far more
    //    useful than an error, since COT only updates weekly anyway.
    if (cached && cached.data) {
      return jsonResponse(cached.data, 200, { "X-Cache": "STALE-ON-ERROR" });
    }
    // Surface the REAL upstream status (or network error) instead of
    // always reporting a generic 502 — this is the difference between
    // "CFTC rejected us with 403" and "CFTC's server actually errored",
    // which previously looked identical from the terminal's point of view.
    const detail = lastError
      ? "network error contacting CFTC: " + lastError.message
      : "CFTC source returned HTTP " + lastStatus + " after " + MAX_ATTEMPTS + " attempts";
    return jsonResponse({ error: { message: detail } }, lastStatus && lastStatus < 500 ? lastStatus : 502);
  }

  let rows;
  try {
    rows = await res.json();
  } catch (e) {
    if (cached && cached.data) {
      return jsonResponse(cached.data, 200, { "X-Cache": "STALE-PARSE-ERROR" });
    }
    return jsonResponse({ error: { message: "CFTC source returned unparseable data: " + e.message } }, 502);
  }

  if (!Array.isArray(rows)) {
    if (cached && cached.data) {
      return jsonResponse(cached.data, 200, { "X-Cache": "STALE-SHAPE-ERROR" });
    }
    return jsonResponse({ error: { message: "CFTC source returned unexpected shape." } }, 502);
  }

  // Sanity check: confirm rows are actually sorted newest-first now that
  // $order is correctly encoded. If the most recent date is more than ~10
  // days old, something is still wrong upstream (CFTC publishes weekly,
  // every Friday) — surface that clearly instead of silently serving stale
  // legacy data again.
  const newestDate = rows.length > 0 ? rows[0].report_date_as_yyyy_mm_dd : null;
  if (newestDate) {
    const ageMs = now - new Date(newestDate).getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    if (ageDays > 10 || ageDays < -1) {
      if (cached && cached.data) {
        return jsonResponse(cached.data, 200, { "X-Cache": "STALE-SUSPICIOUS-DATE" });
      }
      return jsonResponse(
        {
          error: {
            message:
              "CFTC data ordering looks wrong (newest row dated " +
              newestDate +
              ", " +
              Math.round(ageDays) +
              " days old). Expected a report from within the last week.",
          },
        },
        502
      );
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

  const payload = {
    asOf: newestDate,
    markets: result,
    source: "https://publicreporting.cftc.gov/Commitments-of-Traders/TFF-Futures-Only/gpe5-46if (CFTC public API)",
  };

  // 3. Persist to KV so every other isolate / future request benefits,
  //    not just this one. Don't let a KV write failure break the response
  //    we already have — log and continue.
  await writeCotCache(env, { data: payload, fetchedAt: now });

  return jsonResponse(payload, 200, { "X-Cache": "MISS" });
}

// KV read/write helpers — tolerate a missing binding (e.g. local dev
// without KV configured) by behaving as if there's simply no cache yet,
// rather than throwing and taking down the whole /cot endpoint.
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
    const name = (rows[i].market_and_exchange_names || "").toUpperCase();
    // Skip cross-rate contracts (e.g. "EURO FX/JAPANESE YEN XRATE") so a
    // plain currency name like "JAPANESE YEN" only matches the real
    // standalone Japanese Yen futures, not every cross-rate pair that
    // happens to mention yen.
    if (name.indexOf("/") !== -1 || name.indexOf("XRATE") !== -1) continue;
    if (name.indexOf(upperNeedle) !== -1) {
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

  // IMPORTANT: CFTC's actual field names are inconsistent across trader
  // categories — dealer_positions_long_all/short_all DO have an "_all"
  // suffix, but asset_mgr_positions_long/short and lev_money_positions_
  // long/short do NOT. Reading the wrong (nonexistent) field name silently
  // returned undefined -> 0 for every market, which is why Asset Manager
  // and Leveraged Funds always showed flat/zero before. Confirmed directly
  // against CFTC's own x-soda2-fields header via /cot-debug.
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
