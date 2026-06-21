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
    if (cached) {
      return jsonResponse(cached.data, 200, { "X-Cache": "STALE-ON-ERROR" });
    }
    return jsonResponse(
      {
        error: {
          message:
            "CFTC fetch failed after " + MAX_ATTEMPTS + " attempts. Last status: " +
            (lastStatus || "network error") + (lastError ? " (" + lastError.message + ")" : ""),
        },
      },
      502
    );
  }

  let rows;
  try {
    rows = await res.json();
  } catch (e) {
    if (cached) return jsonResponse(cached.data, 200, { "X-Cache": "STALE-PARSE-ERROR" });
    return jsonResponse({ error: { message: "CFTC returned unparseable JSON: " + e.message } }, 502);
  }

  const markets = {};
  let asOf = null;
  for (const ourSym in COT_SYMBOL_MAP) {
    const needle = COT_SYMBOL_MAP[ourSym];
    const row = findFirstMatchingRow(rows, needle);
    if (row) {
      markets[ourSym] = summarizeCotRow(row);
      if (!asOf || row.report_date_as_yyyy_mm_dd > asOf) asOf = row.report_date_as_yyyy_mm_dd;
    }
  }

  const payload = { markets, asOf, fetchedAt: now };
  await writeCotCache(env, payload, now);
  return jsonResponse(payload, 200, { "X-Cache": "MISS" });
}

async function readCotCache(env) {
  try {
    if (!env.COT_KV) return null;
    const raw = await env.COT_KV.get(COT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { data: parsed, fetchedAt: parsed.fetchedAt || 0 };
  } catch (e) {
    return null;
  }
}
async function writeCotCache(env, payload, now) {
  try {
    if (!env.COT_KV) return;
    await env.COT_KV.put(COT_CACHE_KEY, JSON.stringify(payload));
  } catch (e) {
    // non-fatal — cache write failure shouldn't break the response
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
    if (name.indexOf("/") !== -1 || name.indexOf("XRATE") !== -1) continue;
    if (name.indexOf(upperNeedle) !== -1) {
      if (!firstMatch) firstMatch = rows[i];
      if (newestDate && rows[i].report_date_as_yyyy_mm_dd === newestDate) {
        return rows[i];
      }
    }
  }
  return firstMatch;
}

function summarizeCotRow(row) {
  const num = (v) => (v === undefined || v === null || v === "" ? 0 : parseInt(v, 10));
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

// ── FXSSI DEBUG — now returns actual HTML snippets, not just length,
// so the real DOM structure can be inspected before writing a parser.
// Returns several different slices since the sentiment data is likely
// inside a <script> JSON blob or data-* attributes rather than plain
// visible text — searching blind for "% buy" text would be guessing.
async function fetchFxssiRaw() {
  const res = await fetch("https://fxssi.com/tools/current-ratio", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  const html = await res.text();

  // Look for common patterns: JSON embedded in script tags, data attributes
  // with percentages, or class names hinting at sentiment/ratio widgets.
  const scriptBlocks = (html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [])
    .filter(function(s){ return /sentiment|ratio|percent|long|short/i.test(s); })
    .slice(0, 3)
    .map(function(s){ return s.slice(0, 2000); });

  const percentMatches = (html.match(/[\s"'>]\d{1,3}(\.\d+)?\s?%/g) || []).slice(0, 30);

  const dataAttrMatches = (html.match(/data-[a-z-]*(ratio|sentiment|long|short|percent)[a-z-]*="[^"]*"/gi) || []).slice(0, 20);

  // Try to find a section mentioning a known instrument like EURUSD/GBPUSD
  // near a percentage, to locate the actual repeating row structure.
  const eurIdx = html.search(/EUR\s*\/?\s*USD/i);
  const eurContext = eurIdx > -1 ? html.slice(Math.max(0, eurIdx - 300), eurIdx + 700) : null;

  return jsonResponse({
    status: res.status,
    htmlLength: html.length,
    scriptBlocksMatchingKeywords: scriptBlocks,
    percentMatches: percentMatches,
    dataAttrMatches: dataAttrMatches,
    eurUsdContext: eurContext,
  }, 200);
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
