const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Try these news sources in order until one works
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
      return jsonResponse({ error: { message: "Unknown endpoint. Use /calendar or /news." } }, 404);
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
// trigger build
