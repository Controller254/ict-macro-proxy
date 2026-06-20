const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

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
  const res = await fetch("https://feeds.reuters.com/reuters/businessNews", {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ICT-Terminal-Worker/1.0)" },
  });
  if (!res.ok) {
    return jsonResponse({ error: { message: "News source returned " + res.status } }, 502);
  }
  const xml = await res.text();
  const items = parseRssItems(xml);
  return jsonResponse({ items }, 200);
}

function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.split("<item>").slice(1);
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
  return str.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}
// trigger build
