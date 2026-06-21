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

let cotCache = { data: null, fetchedAt: 0 };
const COT_CACHE_MS = 60 * 60 * 1000; // COT updates once a week (Fri), 1hr cache is plenty

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
  US30: "DOW JONES",
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
      if (url.pathname === "/fxssi-raw") {
        return await fetchFxssiRaw();
      }
      return jsonResponse(
        { error: { message: "Unknown endpoint. Use /calendar, /news, /cot, or /fxssi-raw." } },
        404
      );
    } catch (err) {
      return jsonResponse({ error: { message: "Worker error: " + err.message } }, 500);
    }
  },
};

// ── COT (Commitment of Traders) ──────────────────────────────────────────
async function proxyCot(env) {
  const now = Date.now();
  if (cotCache.data && now - cotCache.fetchedAt < COT_CACHE_MS) {
    return jsonResponse(cotCache.data, 200, { "X-Cache": "HIT" });
  }

  // Pull the most recent report for every market in one call, sorted by
  // date descending, then keep only the newest row per market below.
  const orderClause = encodeURIComponent("report_date_as_yyyy_mm_dd DESC");
  const queryUrl = CFTC_TFF_URL + "?$limit=2000&$order=" + orderClause;

  // ROOT CAUSE FIX: repeated 502s here were not a transient blip — Socrata
  // (which powers CFTC's public API) throttles unauthenticated requests by
  // *source IP address*, and every Cloudflare Worker shares a small pool of
  // edge IPs with countless other Socrata consumers worldwide. That shared
  // pool gets exhausted constantly, so retries from a Worker keep landing
  // in the same throttled bucket and keep failing. Per Socrata's own docs
  // (dev.socrata.com/docs/app-tokens), attaching a free app token via the
  // X-App-Token header moves the request out of the shared-IP pool into
  // its own dedicated, effectively unthrottled quota. This is the durable
  // fix; the retry-with-backoff below is now just a safety net for genuine
  // transient blips, not a workaround for the throttling itself.
  //
  // To use: register a free token at
  //   https://publicreporting.cftc.gov/profile/edit/developer_settings
  // then add it as a Cloudflare Worker secret named CFTC_APP_TOKEN
  // (wrangler secret put CFTC_APP_TOKEN, or via the dashboard's
  // Settings -> Variables -> Encrypt). Works fine without one too —
  // you'll just be back in the shared-pool throttling Socrata describes.
  const REALISTIC_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
  const TRANSIENT_STATUSES = [429, 502, 503, 504];
  const MAX_ATTEMPTS = 3;
  const appToken = env && env.CFTC_APP_TOKEN;

  const requestHeaders = {
    "User-Agent": REALISTIC_UA,
    Accept: "application/json",
  };
  if (appToken) {
    requestHeaders["X-App-Token"] = appToken;
  }

  let res = null;
  let lastError = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetch(queryUrl, { headers: requestHeaders });
      lastStatus = res.status;
      if (res.ok) break; // success, stop retrying
      if (TRANSIENT_STATUSES.indexOf(res.status) === -1) break; // non-transient, no point retrying
    } catch (err) {
      lastError = err;
      res = null;
    }
    if (attempt < MAX_ATTEMPTS) {
      // Short backoff: 400ms, then 900ms. Workers have a CPU-time budget,
      // so we keep this brief rather than a long exponential wait. Without
      // an app token this backoff is unlikely to help much, since the
      // shared-IP throttle pool doesn't clear in under a second — but it's
      // a harmless safety net for the genuinely transient case.
      await sleep(attempt === 1 ? 400 : 900);
    }
  }

  if (!res || !res.ok) {
    if (cotCache.data) {
      return jsonResponse(cotCache.data, 200, { "X-Cache": "STALE-ON-ERROR" });
    }
    let detail;
    if (lastError) {
      detail = "network error contacting CFTC: " + lastError.message;
    } else if ((lastStatus === 502 || lastStatus === 429) && !appToken) {
      detail =
        "CFTC source returned HTTP " +
        lastStatus +
        " after " +
        MAX_ATTEMPTS +
        " attempts. This is very likely Socrata's shared-IP throttling " +
        "(no CFTC_APP_TOKEN secret is configured on this Worker) -- " +
        "register a free token at " +
        "https://publicreporting.cftc.gov/profile/edit/developer_settings " +
        "and set it as the CFTC_APP_TOKEN secret to fix this durably.";
    } else {
      detail = "CFTC source returned HTTP " + lastStatus + " after " + MAX_ATTEMPTS + " attempts";
    }
    return jsonResponse({ error: { message: detail } }, lastStatus && lastStatus < 500 ? lastStatus : 502);
  }

  let rows;
  try {
    rows = await res.json();
  } catch (e) {
    if (cotCache.data) {
      return jsonResponse(cotCache.data, 200, { "X-Cache": "STALE-PARSE-ERROR" });
    }
    return jsonResponse({ error: { message: "CFTC source returned unparseable data: " + e.message } }, 502);
  }

  if (!Array.isArray(rows)) {
    if (cotCache.data) {
      return jsonResponse(cotCache.data, 200, { "X-Cache": "STALE-SHAPE-ERROR" });
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
      if (cotCache.data) {
        return jsonResponse(cotCache.data, 200, { "X-Cache": "STALE-SUSPICIOUS-DATE" });
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

  cotCache = { data: payload, fetchedAt: now };
  return jsonResponse(payload, 200, { "X-Cache": "MISS" });
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

  const assetMgrLong = num(row.asset_mgr_positions_long_all);
  const assetMgrShort = num(row.asset_mgr_positions_short_all);
  const levMoneyLong = num(row.lev_money_positions_long_all);
  const levMoneyShort = num(row.lev_money_positions_short_all);
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
