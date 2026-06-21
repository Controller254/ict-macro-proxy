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
      if (url.pathname === "/fxssi-raw") {
        return await fetchFxssiRaw();
      }
      if (url.pathname === "/sentiment") {
        return await proxySentimentFxssi();
      }
      return jsonResponse(
        { error: { message: "Unknown endpoint. Use /calendar, /news, /sentiment, or /fxssi-raw." } },
        404
      );
    } catch (err) {
      return jsonResponse({ error: { message: "Worker error: " + err.message } }, 500);
    }
  },
};

// Returns the raw HTML FXSSI sends back, so we can inspect with our own
// eyes whether the percentages exist in the server response or only
// appear after client-side JavaScript runs in a real browser.
async function fetchFxssiRaw() {
  const res = await fetch("https://fxssi.com/tools/current-ratio", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  const html = await res.text();
  const hasPercent = html.indexOf("%") !== -1;
  const hasEURUSD = html.indexOf("EURUSD") !== -1;
  const snippet = html.length > 3000 ? html.slice(0, 3000) : html;
  return jsonResponse(
    {
      status: res.status,
      htmlLength: html.length,
      containsPercentSign: hasPercent,
      containsEURUSD: hasEURUSD,
      first3000Chars: snippet,
    },
    200
  );
}

async function proxySentimentFxssi() {
  const res = await fetch("https://fxssi.com/tools/current-ratio", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html",
    },
  });
  if (!res.ok) {
    return jsonResponse({ error: { message: "FXSSI returned " + res.status } }, 502);
  }
  const html = await res.text();
  const pairs = parseFxssiSentiment(html);
  if (Object.keys(pairs).length === 0) {
    return jsonResponse(
      {
        error: {
          message: "Could not find sentiment percentages in FXSSI's server response. The data may load via client-side JavaScript only.",
        },
      },
      502
    );
  }
  return jsonResponse({ pairs: pairs, source: "https://fxssi.com/tools/current-ratio" }, 200);
}

function parseFxssiSentiment(html) {
  const result = {};
  const pattern = /([A-Z]{6})[^0-9%]{0,300}?(\d{1,3})\s*%[^0-9%]{0,60}?(\d{1,3})\s*%/g;
  let match;
  const seen = {};
  while ((match = pattern.exec(html)) !== null) {
    const symbol = match[1];
    const buy = parseInt(match[2], 10);
    const sell = parseInt(match[3], 10);
    if (seen[symbol]) continue;
    if (buy + sell !== 100) continue;
    seen[symbol] = true;
    result[symbol] = { buyPct: buy, sellPct: sell };
  }
  return result;
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
