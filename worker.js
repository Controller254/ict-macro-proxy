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

// ── MYFXBOOK COMMUNITY OUTLOOK ───────────────────────────────────────────
// Real retail long/short positioning, free tier: 100 requests/day.
// Requires a registered myfxbook.com account — credentials are read from
// Worker secrets (env.MYFXBOOK_EMAIL / env.MYFXBOOK_PASSWORD), never
// hardcoded here, so they never end up in the GitHub repo this Worker
// deploys from. Set them with:
//   wrangler secret put MYFXBOOK_EMAIL
//   wrangler secret put MYFXBOOK_PASSWORD
// or via the Cloudflare dashboard: Worker -> Settings -> Variables ->
// Encrypt the variable.
//
// Sessions are IP-bound and last 1 month (per Myfxbook's Oct 2025 API
// update) — cached in the same COT_KV namespace under a different key so
// we log in once and reuse the session across requests/isolates, rather
// than spending a login call every time (logins likely count against the
// same rate budget as data calls, though Myfxbook doesn't document this
// explicitly — caching aggressively is the safe assumption either way).
const RETAIL_SESSION_KEY = "myfxbook_session";
const RETAIL_DATA_KEY = "myfxbook_retail_latest";
const RETAIL_DATA_CACHE_MS = 10 * 60 * 1000; // Myfxbook's own outlook refresh cadence is ~10min server-side

// Maps Myfxbook's outlook symbol names to our terminal's symbols. Myfxbook
// only covers FX majors/minors and a few metals — it has no equity index
// or bond coverage, unlike COT, so this list is intentionally shorter.
const RETAIL_SYMBOL_MAP = {
  EURUSD: "EURUSD",
  GBPUSD: "GBPUSD",
  USDJPY: "USDJPY",
  AUDUSD: "AUDUSD",
  USDCAD: "USDCAD",
  USDCHF: "USDCHF",
  NZDUSD: "NZDUSD",
  XAUUSD: "XAUUSD",
  XAGUSD: "XAGUSD",
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
      if (url.pathname === "/retail") {
        return await proxyRetail(env);
      }
      if (url.pathname === "/retail-debug") {
        return await debugRetail(env);
      }
      return jsonResponse(
        { error: { message: "Unknown endpoint. Use /calendar, /news, /cot, /cot-debug, /fxssi-raw, /retail, or /retail-debug." } },
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

// ── MYFXBOOK RETAIL POSITIONING ──────────────────────────────────────────
async function getCachedSession(env) {
  try {
    if (!env.COT_KV) return null;
    const raw = await env.COT_KV.get(RETAIL_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw); // { session, loggedInAt }
  } catch (e) {
    return null;
  }
}
async function setCachedSession(env, session) {
  try {
    if (!env.COT_KV) return;
    await env.COT_KV.put(RETAIL_SESSION_KEY, JSON.stringify({ session, loggedInAt: Date.now() }));
  } catch (e) {
    // non-fatal
  }
}
async function clearCachedSession(env) {
  try {
    if (!env.COT_KV) return;
    await env.COT_KV.delete(RETAIL_SESSION_KEY);
  } catch (e) {
    // non-fatal
  }
}

// Logs in fresh and caches the resulting session. Throws with the real
// Myfxbook error message on failure (e.g. "Wrong email/password") rather
// than a generic network error, since that distinction matters for
// diagnosing a misconfigured secret vs an actual outage.
async function myfxbookLogin(env) {
  if (!env.MYFXBOOK_EMAIL || !env.MYFXBOOK_PASSWORD) {
    throw new Error(
      "MYFXBOOK_EMAIL / MYFXBOOK_PASSWORD secrets are not set on this Worker. Set them via `wrangler secret put MYFXBOOK_EMAIL` (and PASSWORD), or in the Cloudflare dashboard under Worker -> Settings -> Variables."
    );
  }
  const loginUrl =
    "https://www.myfxbook.com/api/login.json?email=" +
    encodeURIComponent(env.MYFXBOOK_EMAIL) +
    "&password=" +
    encodeURIComponent(env.MYFXBOOK_PASSWORD);
  const res = await fetch(loginUrl);
  if (!res.ok) throw new Error("Myfxbook login HTTP " + res.status);
  const data = await res.json();
  if (data.error) throw new Error("Myfxbook login rejected: " + (data.message || "unknown reason"));
  if (!data.session) throw new Error("Myfxbook login returned no session token");
  await setCachedSession(env, data.session);
  return data.session;
}

// Tries the cached session first; if Myfxbook reports it invalid/expired,
// logs in fresh exactly once and retries. This keeps normal operation to
// zero logins per request (session lasts ~1 month) while still
// self-healing after expiry without manual intervention.
async function getCommunityOutlook(env) {
  const cached = await getCachedSession(env);
  let session = cached && cached.session;

  if (!session) {
    session = await myfxbookLogin(env);
  }

  let res = await fetch(
    "https://www.myfxbook.com/api/get-community-outlook.json?session=" + encodeURIComponent(session)
  );
  let data = await res.json();

  if (data.error && /session/i.test(data.message || "")) {
    // Cached session expired/invalid — log in fresh once and retry.
    await clearCachedSession(env);
    session = await myfxbookLogin(env);
    res = await fetch(
      "https://www.myfxbook.com/api/get-community-outlook.json?session=" + encodeURIComponent(session)
    );
    data = await res.json();
  }

  if (data.error) {
    throw new Error("Myfxbook get-community-outlook error: " + (data.message || "unknown reason"));
  }
  return data;
}

async function proxyRetail(env) {
  const now = Date.now();

  // Serve from cache if fresh — Myfxbook's own data refreshes ~every 10min,
  // no point hitting their API more often than that.
  try {
    if (env.COT_KV) {
      const raw = await env.COT_KV.get(RETAIL_DATA_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (now - cached.fetchedAt < RETAIL_DATA_CACHE_MS) {
          return jsonResponse(cached.payload, 200, { "X-Cache": "HIT" });
        }
      }
    }
  } catch (e) {
    // fall through to a live fetch if cache read fails for any reason
  }

  let outlook;
  try {
    outlook = await getCommunityOutlook(env);
  } catch (err) {
    // Stale-on-error: if we have ANY previous successful data, prefer
    // serving that over a hard failure — same pattern as /calendar.
    try {
      if (env.COT_KV) {
        const raw = await env.COT_KV.get(RETAIL_DATA_KEY);
        if (raw) {
          const cached = JSON.parse(raw);
          return jsonResponse(cached.payload, 200, { "X-Cache": "STALE-ON-ERROR" });
        }
      }
    } catch (e2) {
      // no stale copy available either
    }
    return jsonResponse({ error: { message: err.message } }, 502);
  }

  const symbols = {};
  (outlook.symbols || []).forEach((s) => {
    const ourSym = Object.keys(RETAIL_SYMBOL_MAP).find((k) => RETAIL_SYMBOL_MAP[k] === s.name);
    if (ourSym) {
      symbols[ourSym] = {
        longPercentage: s.longPercentage,
        shortPercentage: s.shortPercentage,
        longVolume: s.longVolume,
        shortVolume: s.shortVolume,
        totalPositions: s.totalPositions,
      };
    }
  });

  const payload = { symbols, fetchedAt: now };
  try {
    if (env.COT_KV) {
      await env.COT_KV.put(RETAIL_DATA_KEY, JSON.stringify({ payload, fetchedAt: now }));
    }
  } catch (e) {
    // non-fatal
  }
  return jsonResponse(payload, 200, { "X-Cache": "MISS" });
}

// Diagnostic endpoint — surfaces exactly where in the login -> outlook
// chain things fail, with the real Myfxbook message, rather than the
// terminal seeing only a generic 502.
//
// Also reports SAFE metadata about the two secrets (length, and the char
// code of the first/last character) WITHOUT ever exposing the actual
// value — this exists purely to catch a stray trailing space, smart-quote,
// or newline that got pasted into the Cloudflare secret field, which
// looks identical to the correct value on screen but fails byte-for-byte
// comparison against what Myfxbook expects.
function safeSecretInfo(value) {
  if (!value) return null;
  return {
    length: value.length,
    firstCharCode: value.charCodeAt(0),
    lastCharCode: value.charCodeAt(value.length - 1),
    hasLeadingWhitespace: /^\s/.test(value),
    hasTrailingWhitespace: /\s$/.test(value),
  };
}

async function debugRetail(env) {
  const out = { hasEmailSecret: !!env.MYFXBOOK_EMAIL, hasPasswordSecret: !!env.MYFXBOOK_PASSWORD };
  out.emailSecretInfo = safeSecretInfo(env.MYFXBOOK_EMAIL);
  out.passwordSecretInfo = safeSecretInfo(env.MYFXBOOK_PASSWORD);
  try {
    const cached = await getCachedSession(env);
    out.cachedSessionPresent = !!(cached && cached.session);
    out.cachedSessionAgeMs = cached ? Date.now() - cached.loggedInAt : null;
  } catch (e) {
    out.cacheReadError = e.message;
  }
  try {
    const outlook = await getCommunityOutlook(env);
    out.loginAndFetchSucceeded = true;
    out.symbolCount = (outlook.symbols || []).length;
    out.sampleSymbol = (outlook.symbols || [])[0] || null;
  } catch (err) {
    out.loginAndFetchSucceeded = false;
    out.error = err.message;
  }
  return jsonResponse(out, 200);
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
