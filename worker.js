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

export default {
  async fetch(request) {
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
      if (url.pathname === "/sentiment") {
        return await proxySentiment();
      }
      return jsonResponse({ error: { message: "Unknown endpoint. Use /calendar, /news, or /sentiment." } }, 404);
    } catch (err) {
      return jsonResponse({ error: { message: "Worker error: " + err.message } }, 500);
    }
  },
};

async function proxyCalendar() {
  const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ICT-Terminal-Worker/1.0)" },
  });
  if (!res.ok) {
    return jsonResponse({ error: { message: "Calendar source returned " + res.status } }, 502);
  }
  const data = await res.json();
  return jsonResponse(data, 200);
}

async function proxyNews() {
  const errors = [];
  for (const sourceUrl of NEWS_SOURCES) {
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
        return jsonResponse({ items, source: sourceUrl }, 200);
      }
      errors.push(sourceUrl + " -> parsed 0 items");
    } catch (err) {
      errors.push(sourceUrl + " -> " + err.message);
    }
  }
  return jsonResponse({ error: { message: "All news sources failed: " + errors.join(" | ") } }, 502);
}

// Fetches FXSSI's Current Ratio page server-side and parses the real
// buy/sell percentage table out of the raw HTML. No iframe, no JS
// rendering needed - the numbers are plain text in the page source.
async function proxySentiment() {
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
  const data = parseFxssiSentiment(html);
  if (Object.keys(data).length === 0) {
    return jsonResponse({ error: { message: "Could not parse sentiment table from FXSSI page" } }, 502);
  }
  return jsonResponse({ pairs: data, source: "https://fxssi.com/tools/current-ratio" }, 200);
}

// The Quick Sentiment table on the page renders as repeating
// SYMBOL / BUY% / SELL% text blocks. We match that pattern directly.
function parseFxssiSentiment(html) {
  const result = {};
  // Matches things like: EURUSD</...>...61%...39%
  const pattern = /([A-Z]{6})[^0-9]{1,400}?(\d{1,3})\s*%[^0-9]{1,40}?(\d{1,3})\s*%/g;
  let match;
  const seen = new Set();
  while ((match = pattern.exec(html)) !== null) {
    const symbol = match[1];
    const buy = parseInt(match[2], 10);
    const sell = parseInt(match[3], 10);
    if (seen.has(symbol)) continue;
    if (buy + sell !== 100) continue; // sanity check - real pairs sum to 100
    if (buy < 0 || buy > 100) continue;
    seen.add(symbol);
    result[symbol] = { buyPct: buy, sellPct: sell };
  }
  return result;
}

function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.split(/<item[ >]/i).slice(1);
  for (const block of itemBlocks.slice(0, 10)) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    if (title) items.push({ title: decodeEntities(title), link: link || "" });
  }
  return items;
}

function extractTag(block, tag) {
  const match = block.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">"));
  if (!match) return "";
  return match[1].replace("<![CDATA[", "").replace("]]>", "").trim();
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
  const itemBlocks = xml.split(/<item[ >]/i).slice(1);
  for (const block of itemBlocks.slice(0, 10)) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    if (title) items.push({ title: decodeEntities(title), link: link || "" });
  }
  return items;
}

function extractTag(block, tag) {
  const match = block.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">"));
  if (!match) return "";
  return match[1].replace("<![CDATA[", "").replace("]]>", "").trim();
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
// trigger build
