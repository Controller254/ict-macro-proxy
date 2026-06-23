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

let pricesCache = { data: null, fetchedAt: 0 };
const PRICES_CACHE_MS = 15 * 1000; // 15s - short enough to feel live, long enough to avoid hammering Yahoo

// Live prices: Yahoo Finance's unofficial chart endpoint (the same one the
// `yfinance` Python library uses under the hood). It is NOT a documented
// public API and Yahoo can change/throttle it without notice - but it is
// free, keyless, and as of 2026 still the most reliable no-signup source
// for forex/indices/yields. Running it HERE (server-side, in the Worker)
// rather than from the browser solves the real reliability problems:
// no CORS issues, no per-user-IP rate limiting, and if Yahoo ever breaks
// we can swap the source in one place without the terminal knowing.
//
// Crypto is NOT included here - the terminal already gets that for free,
// live, with no key, directly from Binance's public WebSocket.
const YAHOO_SYMBOL_MAP = {
  EURUSD: "EURUSD=X",
  GBPUSD: "GBPUSD=X",
  USDJPY: "USDJPY=X",
  AUDUSD: "AUDUSD=X",
  USDCAD: "USDCAD=X",
  USDCHF: "USDCHF=X",
  NZDUSD: "NZDUSD=X",
  XAUUSD: "GC=F", // Gold futures (continuous front month)
  XAGUSD: "SI=F", // Silver futures
  USOIL: "CL=F", // WTI Crude futures
  NATGAS: "NG=F", // Natural Gas futures
  NAS100: "^NDX",
  SP500: "^GSPC",
  US30: "^DJI",
  UK100: "^FTSE",
  GER40: "^GDAXI",
  DXY: "DX-Y.NYB",
  US10Y: "^TNX", // CBOE 10yr yield index, value is already in percent (e.g. 4.45 = 4.45%)
  US30Y: "^TYX", // CBOE 30yr yield index, same convention
};

// CFTC's Traders in Financial Futures (TFF) dataset, Socrata Open Data API.
// Free, public, no key, no login - government open data.
// https://publicreporting.cftc.gov/Commitments-of-Traders/TFF-Futures-Only/gpe5-46if
const CFTC_TFF_URL = "https://publicreporting.cftc.gov/resource/gpe5-46if.json";

// Maps our terminal's symbols to CFTC's EXACT "Market_and_Exchange_Names" text
// (verified against live API responses — not loose substrings). Loose
// substrings like "EURO FX" or "DOW JONES" silently match the wrong contract
// when CFTC lists multiple similarly-named markets (e.g. "EURO FX/BRITISH
// POUND XRATE", "DOW JONES U.S. REAL ESTATE IDX"), so every entry here is
// the full exact name of the standard, single contract we actually want.
//
// These live in the TFF (Traders in Financial Futures) dataset — currencies,
// rates, and equity indices only. TFF does NOT cover physical commodities.
const COT_SYMBOL_MAP = {
  EURUSD: "EURO FX - CHICAGO MERCANTILE EXCHANGE",
  GBPUSD: "BRITISH POUND - CHICAGO MERCANTILE EXCHANGE",
  USDJPY: "JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE",
  AUDUSD: "AUSTRALIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE",
  USDCAD: "CANADIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE",
  USDCHF: "SWISS FRANC - CHICAGO MERCANTILE EXCHANGE",
  NZDUSD: "NEW ZEALAND DOLLAR - CHICAGO MERCANTILE EXCHANGE",
  DXY: "USD INDEX - ICE FUTURES U.S.",
  NAS100: "NASDAQ-100 Consolidated - CHICAGO MERCANTILE EXCHANGE",
  SP500: "E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE",
  US30: "DOW JONES INDUSTRIAL AVERAGE - CHICAGO BOARD OF TRADE",
  US10Y: "10-YEAR U.S. TREASURY NOTES - CHICAGO BOARD OF TRADE",
  US30Y: "ULTRA U.S. TREASURY BONDS - CHICAGO BOARD OF TRADE",
};

// GOLD and SILVER are NOT in the TFF dataset at all — CFTC only reports
// metals/physical commodities in the Disaggregated Futures-Only report,
// which uses a different resource ID AND different trader categories
// (Producer/Merchant, Swap Dealer, Managed Money, Other — not Dealer/
// Asset Manager/Leveraged Funds). Fetched and summarized separately below.
const CFTC_DISAGG_URL = "https://publicreporting.cftc.gov/resource/72hh-3qpy.json";
const COT_DISAGG_SYMBOL_MAP = {
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
        return await proxyCot();
      }
      if (url.pathname === "/prices") {
        return await proxyPrices();
      }
      if (url.pathname === "/fxssi-raw") {
        return await fetchFxssiRaw();
      }
      return jsonResponse(
        { error: { message: "Unknown endpoint. Use /calendar, /news, /cot, /prices, or /fxssi-raw." } },
        404
      );
    } catch (err) {
      return jsonResponse({ error: { message: "Worker error: " + err.message } }, 500);
    }
  },
};

// ── COT (Commitment of Traders) ──────────────────────────────────────────
async function proxyCot() {
  const now = Date.now();
  if (cotCache.data && now - cotCache.fetchedAt < COT_CACHE_MS) {
    return jsonResponse(cotCache.data, 200, { "X-Cache": "HIT" });
  }

  // Pull the most recent report for every market in one call, sorted by
  // date descending, then keep only the newest row per market below.
  const queryUrl = CFTC_TFF_URL + "?$limit=500&$order=report_date_as_yyyy_mm_dd DESC";
  const res = await fetch(queryUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ICT-Terminal-Worker/1.0)" },
  });

  if (!res.ok) {
    if (cotCache.data) {
      return jsonResponse(cotCache.data, 200, { "X-Cache": "STALE-ON-ERROR" });
    }
    return jsonResponse({ error: { message: "CFTC source returned " + res.status } }, 502);
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

  const result = {};
  for (const ourSymbol in COT_SYMBOL_MAP) {
    const needle = COT_SYMBOL_MAP[ourSymbol];
    const match = findFirstMatchingRow(rows, needle);
    if (match) {
      result[ourSymbol] = summarizeCotRow(match);
    }
  }

  const payload = {
    asOf: rows.length > 0 ? rows[0].report_date_as_yyyy_mm_dd : null,
    markets: result,
    source: "https://publicreporting.cftc.gov/Commitments-of-Traders/TFF-Futures-Only/gpe5-46if (CFTC public API)",
  };

  cotCache = { data: payload, fetchedAt: now };
  return jsonResponse(payload, 200, { "X-Cache": "MISS" });
}

function findFirstMatchingRow(rows, needle) {
  for (let i = 0; i < rows.length; i++) {
    const name = rows[i].market_and_exchange_names || "";
    if (name.toUpperCase().indexOf(needle.toUpperCase()) !== -1) {
      return rows[i];
    }
  }
  return null;
}

function summarizeCotRow(row) {
  const num = (v) => (v === undefined || v === null || v === "" ? 0 : parseInt(v, 10));

  // NOTE: CFTC's Socrata API is inconsistent about the "_all" suffix across
  // trader categories. Verified against a live response (2026-05-05 report):
  // dealer_positions_long_all / dealer_positions_short_all DO carry "_all",
  // but asset_mgr_positions_long / asset_mgr_positions_short and
  // lev_money_positions_long / lev_money_positions_short do NOT. Reading the
  // wrong field name returns undefined -> num() silently defaults to 0 for
  // every market, which is why this previously showed "FLAT 0" everywhere.
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

// ── LIVE PRICES (forex/indices/yields via Yahoo's v8 chart endpoint) ──────
// NOTE ON SOURCE STABILITY: Yahoo's v7 quote endpoint started requiring a
// crumb/cookie auth flow in 2026 and no longer works as a simple GET. The
// v8 CHART endpoint does not have this requirement as of this writing and
// is what this function uses - one request per symbol (chart endpoints
// don't support batching), run in parallel. If Yahoo ever locks this down
// too, this is the one function that needs a new source - nothing else
// in the terminal needs to change, since it only ever talks to OUR /prices
// endpoint, never to Yahoo directly.
async function proxyPrices() {
  const now = Date.now();
  if (pricesCache.data && now - pricesCache.fetchedAt < PRICES_CACHE_MS) {
    return jsonResponse(pricesCache.data, 200, { "X-Cache": "HIT" });
  }

  const ourSymbols = Object.keys(YAHOO_SYMBOL_MAP);
  const results = await Promise.all(
    ourSymbols.map(async (ourSymbol) => {
      const yahooSymbol = YAHOO_SYMBOL_MAP[ourSymbol];
      try {
        const quote = await fetchYahooChartQuote(yahooSymbol);
        return { ourSymbol, quote, error: null };
      } catch (err) {
        return { ourSymbol, quote: null, error: err.message };
      }
    })
  );

  const prices = {};
  const errors = [];
  for (const r of results) {
    if (r.quote) {
      prices[r.ourSymbol] = r.quote;
    } else {
      errors.push(r.ourSymbol + ": " + r.error);
    }
  }

  const successCount = Object.keys(prices).length;
  if (successCount === 0) {
    // Total failure across every symbol - almost certainly Yahoo blocking the
    // Worker's IP/UA rather than 19 unrelated tickers failing independently.
    if (pricesCache.data) {
      return jsonResponse(pricesCache.data, 200, { "X-Cache": "STALE-ON-ERROR" });
    }
    return jsonResponse(
      { error: { message: "All price fetches failed - source may be unavailable: " + errors.join(" | ") } },
      502
    );
  }

  const payload = {
    prices: prices,
    errors: errors.length ? errors : undefined,
    asOf: new Date(now).toISOString(),
    source: "Yahoo Finance v8 chart endpoint (unofficial, no key)",
  };

  pricesCache = { data: payload, fetchedAt: now };
  return jsonResponse(payload, 200, { "X-Cache": successCount < ourSymbols.length ? "PARTIAL-MISS" : "MISS" });
}

async function fetchYahooChartQuote(yahooSymbol) {
  const chartUrl =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(yahooSymbol) +
    "?range=1d&interval=1m";
  const res = await fetch(chartUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error("HTTP " + res.status);
  }
  const data = await res.json();
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result || !result.meta) {
    throw new Error("unexpected response shape");
  }
  const meta = result.meta;
  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose;
  if (price == null) {
    throw new Error("no regularMarketPrice in response");
  }
  const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
  return {
    price: price,
    prevClose: prevClose != null ? prevClose : null,
    changePct: changePct,
    currency: meta.currency || null,
    marketTime: meta.regularMarketTime ? meta.regularMarketTime * 1000 : null,
  };
}


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
