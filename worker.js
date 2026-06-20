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

let myfxbookSession = { id: null, fetchedAt: 0 };
const MYFXBOOK_SESSION_TTL_MS = 50 * 60 * 1000;

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
      if (url.pathname === "/sentiment") {
        return await proxySentiment(env);
      }
      return jsonResponse(
        { error: { message: "Unknown endpoint. Use /calendar, /news, or /sentiment." } },
        404
      );
    } catch (err) {
      return jsonResponse({ error: { message: "Worker error: " + err.message } }, 500);
    }
  },
};

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
    return jsonResponse(
      { error: { message: "Calendar source returned " + res.status } },
      502
    );
  }

  const text = await res.text();

  const looksLikeHtml = /^\s*<(!doctype|html)/i.test(text);
  if (looksLikeHtml) {
    if (calendarCache.data) {
      return jsonResponse(calendarCache.data, 200, { "X-Cache": "STALE-RATE-LIMITED" });
    }
    return jsonResponse(
      {
        error: {
          message:
            "Calendar source rate-limited this Worker (FairEconomy allows ~2 requests/5min/IP). Try again shortly — responses are cached for 5 minutes to avoid this.",
        },
      },
      429
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    if (calendarCache.data) {
      return jsonResponse(calendarCache.data, 200, { "X-Cache": "STALE-PARSE-ERROR" });
    }
    return jsonResponse(
      { error: { message: "Calendar source returned unparseable data: " + e.message } },
      502
    );
  }

  if (!Array.isArray(data)) {
    if (calendarCache.data) {
      return jsonResponse(calendarCache.data, 200, { "X-Cache": "STALE-SHAPE-ERROR" });
    }
    return jsonResponse(
      { error: { message: "Calendar source returned unexpected shape (not an array)." } },
      502
    );
  }

  calendarCache = { data, fetchedAt: now };
  return jsonResponse(data, 200, { "X-Cache": "MISS" });
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
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks.slice(0, 20)) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate") || extractTag(block, "dc:date");
    const description = extractTag(block, "description");
    if (title) {
      items.push({
        title: decodeEntities(stripCdata(title)),
        link: link ? decodeEntities(stripCdata(link)).trim() : "",
        pubDate: pubDate ? decodeEntities(stripCdata(pubDate)).trim() : "",
        description: description ? stripHtml(decodeEntities(stripCdata(description))).slice(0, 280) : "",
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

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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

async function getMyfxbookSession(env) {
  const now = Date.now();
  if (myfxbookSession.id && now - myfxbookSession.fetchedAt < MYFXBOOK_SESSION_TTL_MS) {
    return myfxbookSession.id;
  }
  const email = env.MYFXBOOK_EMAIL;
  const password = env.MYFXBOOK_PASSWORD;

  console.log("DEBUG email value:", JSON.stringify(email), "| email length:", email ? email.length : 0, "| password length:", password ? password.length : 0);

  if (!email || !password) {
    return null;
  }
  const loginUrl =
    "https://www.myfxbook.com/api/login.json?email=" +
    encodeURIComponent(email) +
    "&password=" +
    encodeURIComponent(password);
  const res = await fetch(loginUrl);
  if (!res.ok) throw new Error("Myfxbook login HTTP " + res.status);
  const data = await res.json();
  if (data.error || !data.session) {
    throw new Error("Myfxbook login failed: " + (data.message || "no session returned"));
  }
  myfxbookSession = { id: data.session, fetchedAt: now };
  return data.session;
}

async function proxySentiment(env) {
  let session;
  try {
    session = await getMyfxbookSession(env);
  } catch (err) {
    return jsonResponse(
      { error: { message: "Myfxbook authentication failed: " + err.message } },
      502
    );
  }

  if (!session) {
    return jsonResponse(
      {
        error: {
          message:
            "Sentiment not configured. Set MYFXBOOK_EMAIL and MYFXBOOK_PASSWORD as Worker secrets.",
        },
      },
      501
    );
  }

  const outlookUrl =
    "https://www.myfxbook.com/api/get-community-outlook.json?session=" + encodeURIComponent(session);
  const res = await fetch(outlookUrl);
  if (!res.ok) {
    return jsonResponse({ error: { message: "Myfxbook outlook returned " + res.status } }, 502);
  }
  const data = await res.json();
  if (data.error) {
    myfxbookSession = { id: null, fetchedAt: 0 };
    return jsonResponse(
      { error: { message: "Myfxbook outlook error: " + (data.message || "unknown") } },
      502
    );
  }

  const symbols = Array.isArray(data.symbols) ? data.symbols : [];
  const pairs = {};
  for (const s of symbols) {
    if (!s.name) continue;
    pairs[s.name] = {
      longPercentage: s.longPercentage,
      shortPercentage: s.shortPercentage,
      longVolume: s.longVolume,
      shortVolume: s.shortVolume,
    };
  }

  return jsonResponse(
    { pairs, source: "https://www.myfxbook.com/community/outlook (Community Outlook API)" },
    200
  );
}

function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...(extraHeaders || {}),
    },
  });
}    // Serve stale cache rather than fail outright, if we have any
    if (calendarCache.data) {
      return jsonResponse(calendarCache.data, 200, { "X-Cache": "STALE-ON-ERROR" });
    }
    return jsonResponse(
      { error: { message: "Calendar source returned " + res.status } },
      502
    );
  }

  const text = await res.text();

  // FairEconomy returns an HTML "Request Denied" page (not JSON) when their
  // shared rate limit (2 requests / 5 min / IP) is exceeded. Detect that
  // before trying to JSON.parse, so we can give a clear error instead of a
  // confusing parse exception.
  const looksLikeHtml = /^\s*<(!doctype|html)/i.test(text);
  if (looksLikeHtml) {
    if (calendarCache.data) {
      return jsonResponse(calendarCache.data, 200, { "X-Cache": "STALE-RATE-LIMITED" });
    }
    return jsonResponse(
      {
        error: {
          message:
            "Calendar source rate-limited this Worker (FairEconomy allows ~2 requests/5min/IP). Try again shortly — responses are cached for 5 minutes to avoid this.",
        },
      },
      429
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    if (calendarCache.data) {
      return jsonResponse(calendarCache.data, 200, { "X-Cache": "STALE-PARSE-ERROR" });
    }
    return jsonResponse(
      { error: { message: "Calendar source returned unparseable data: " + e.message } },
      502
    );
  }

  if (!Array.isArray(data)) {
    if (calendarCache.data) {
      return jsonResponse(calendarCache.data, 200, { "X-Cache": "STALE-SHAPE-ERROR" });
    }
    return jsonResponse(
      { error: { message: "Calendar source returned unexpected shape (not an array)." } },
      502
    );
  }

  calendarCache = { data, fetchedAt: now };
  return jsonResponse(data, 200, { "X-Cache": "MISS" });
}

// ── NEWS ──────────────────────────────────────────────────────────────────
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
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks.slice(0, 20)) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate") || extractTag(block, "dc:date");
    const description = extractTag(block, "description");
    if (title) {
      items.push({
        title: decodeEntities(stripCdata(title)),
        link: link ? decodeEntities(stripCdata(link)).trim() : "",
        pubDate: pubDate ? decodeEntities(stripCdata(pubDate)).trim() : "",
        description: description ? stripHtml(decodeEntities(stripCdata(description))).slice(0, 280) : "",
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

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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

// ── SENTIMENT (Myfxbook Community Outlook) ──────────────────────────────────
// FXSSI has no public API and its widget data is loaded client-side via JS,
// so server-side scraping of the static HTML always returns nothing — that
// was the root cause of the old /sentiment endpoint failing. Myfxbook is the
// closest equivalent with a real, documented JSON API, but it requires an
// authenticated session (free account). We log in once with Worker secrets
// and cache the session for ~50 minutes, well under Myfxbook's ~1hr expiry.
async function getMyfxbookSession(env) {
  const now = Date.now();
  if (myfxbookSession.id && now - myfxbookSession.fetchedAt < MYFXBOOK_SESSION_TTL_MS) {
    return myfxbookSession.id;
  }
  const email = env.MYFXBOOK_EMAIL;
  const password = env.MYFXBOOK_PASSWORD;
  if (!email || !password) {
    return null; // not configured
  }
  const loginUrl =
    "https://www.myfxbook.com/api/login.json?email=" +
    encodeURIComponent(email) +
    "&password=" +
    encodeURIComponent(password);
  const res = await fetch(loginUrl);
  if (!res.ok) throw new Error("Myfxbook login HTTP " + res.status);
  const data = await res.json();
  if (data.error || !data.session) {
    throw new Error("Myfxbook login failed: " + (data.message || "no session returned"));
  }
  myfxbookSession = { id: data.session, fetchedAt: now };
  return data.session;
}

async function proxySentiment(env) {
  let session;
  try {
    session = await getMyfxbookSession(env);
  } catch (err) {
    return jsonResponse(
      { error: { message: "Myfxbook authentication failed: " + err.message } },
      502
    );
  }

  if (!session) {
    return jsonResponse(
      {
        error: {
          message:
            "Sentiment not configured. FXSSI has no public API (its data is JS-rendered, not scrapeable). " +
            "Set MYFXBOOK_EMAIL and MYFXBOOK_PASSWORD as Worker secrets (free account at myfxbook.com) to enable this endpoint: " +
            "npx wrangler secret put MYFXBOOK_EMAIL && npx wrangler secret put MYFXBOOK_PASSWORD",
        },
      },
      501
    );
  }

  const outlookUrl =
    "https://www.myfxbook.com/api/get-community-outlook.json?session=" + encodeURIComponent(session);
  const res = await fetch(outlookUrl);
  if (!res.ok) {
    return jsonResponse({ error: { message: "Myfxbook outlook returned " + res.status } }, 502);
  }
  const data = await res.json();
  if (data.error) {
    // Session may have expired early — force a fresh login next call
    myfxbookSession = { id: null, fetchedAt: 0 };
    return jsonResponse(
      { error: { message: "Myfxbook outlook error: " + (data.message || "unknown") } },
      502
    );
  }

  const symbols = Array.isArray(data.symbols) ? data.symbols : [];
  const pairs = {};
  for (const s of symbols) {
    if (!s.name) continue;
    pairs[s.name] = {
      longPercentage: s.longPercentage,
      shortPercentage: s.shortPercentage,
      longVolume: s.longVolume,
      shortVolume: s.shortVolume,
    };
  }

  return jsonResponse(
    { pairs, source: "https://www.myfxbook.com/community/outlook (Community Outlook API)" },
    200
  );
}

// ── HELPERS ──────────────────────────────────────────────────────────────
function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...(extraHeaders || {}),
    },
  });
}
