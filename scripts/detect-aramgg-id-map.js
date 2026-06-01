import * as cheerio from "cheerio";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = "https://aramgg.com";
const LANG = "zh-CN";
const OUT_PATH = path.join("data", "aramgg-id-map-detection.json");
const CDRAGON_PATH = path.join("data", "cdragon-arena-augments.json");

const TARGET_IDS = (process.env.ARAMGG_TARGET_IDS || "1225,1220,2010,1346,1073,1238,1195,1356,1081,1052,1051,1071")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const SAMPLE_CHAMPION_KEYS = (process.env.ARAMGG_SAMPLE_CHAMPIONS || "22,222,1,103,157,51,145,81,64")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const MAX_SCRIPT_FILES = Number(process.env.MAX_SCRIPT_FILES || 120);

function normalizeText(text = "") {
  return String(text).replace(/\s+/g, " ").trim();
}

function absoluteUrl(url) {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${BASE}${url}`;
  return `${BASE}/${url}`;
}

function normalizeIconKey(value = "") {
  return String(value)
    .toLowerCase()
    .split("?")[0]
    .split("#")[0]
    .split("/")
    .pop()
    .replace(/\.(png|jpg|jpeg|webp)$/i, "")
    .replace(/_(large|small)$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status}: ${url}`);
  }

  return await response.text();
}

async function loadCdragonHints() {
  try {
    const raw = await readFile(CDRAGON_PATH, "utf8");
    const data = JSON.parse(raw);

    const hints = [];

    for (const item of data.augments || []) {
      const hint = {
        cdragonId: String(item.id || ""),
        nameZh: item.nameZh || item.name || "",
        nameEn: item.nameEn || "",
        apiName: item.apiName || "",
        icon: item.icon || "",
        iconKey: normalizeIconKey(item.icon || item.apiName || item.nameEn || ""),
      };

      if (hint.nameZh || hint.nameEn || hint.apiName || hint.iconKey) {
        hints.push(hint);
      }
    }

    return {
      loaded: true,
      count: hints.length,
      hints,
    };
  } catch (error) {
    return {
      loaded: false,
      count: 0,
      error: error.message,
      hints: [],
    };
  }
}

function collectScriptUrls(html, pageUrl) {
  const $ = cheerio.load(html);
  const urls = new Set();

  $("script[src]").each((_, el) => {
    urls.add(absoluteUrl($(el).attr("src")));
  });

  $("link[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const rel = ($(el).attr("rel") || "").toLowerCase();
    if (href.endsWith(".js") || rel.includes("preload") || rel.includes("modulepreload")) {
      urls.add(absoluteUrl(href));
    }
  });

  // Next.js manifests/chunks often appear inside HTML text.
  const regexes = [
    /"([^"]+?\.js)"/g,
    /'([^']+?\.js)'/g,
    /(\/_next\/static\/[^"'<> ]+?\.js)/g,
  ];

  for (const regex of regexes) {
    let match;
    while ((match = regex.exec(html))) {
      urls.add(absoluteUrl(match[1]));
    }
  }

  return [...urls].filter((url) => url.startsWith("http"));
}

function collectInlineData(html, pageUrl) {
  const $ = cheerio.load(html);
  const chunks = [];

  $("script").each((index, el) => {
    const src = $(el).attr("src");
    if (src) return;

    const text = $(el).contents().text();
    if (!text || text.length < 20) return;

    chunks.push({
      url: `${pageUrl}#inline-script-${index}`,
      type: "inline-script",
      text,
    });
  });

  const nextData = $("#__NEXT_DATA__").text();
  if (nextData) {
    chunks.push({
      url: `${pageUrl}#__NEXT_DATA__`,
      type: "next-data",
      text: nextData,
    });
  }

  return chunks;
}

function snippetsAroundTargets(text, url, type, targetIds) {
  const results = [];

  for (const id of targetIds) {
    const regex = new RegExp(`(?<!\\d)#?${escapeRegex(id)}(?!\\d)`, "g");
    let match;

    while ((match = regex.exec(text))) {
      const start = Math.max(0, match.index - 600);
      const end = Math.min(text.length, match.index + 600);
      const snippet = text.slice(start, end);

      results.push({
        aramggId: id,
        url,
        type,
        index: match.index,
        snippet: normalizeText(snippet),
      });

      if (results.filter((item) => item.aramggId === id && item.url === url).length >= 20) {
        break;
      }
    }
  }

  return results;
}

function scoreSnippet(snippet, cdragonHints) {
  const text = snippet.snippet;
  const compactLower = text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");

  const matches = [];

  for (const hint of cdragonHints) {
    const tests = [
      { kind: "nameZh", value: hint.nameZh, weight: 100 },
      { kind: "nameEn", value: hint.nameEn, weight: 80 },
      { kind: "apiName", value: hint.apiName, weight: 90 },
      { kind: "iconKey", value: hint.iconKey, weight: 120 },
    ].filter((item) => item.value);

    let score = 0;
    const hitKinds = [];

    for (const test of tests) {
      const normalized = String(test.value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
      if (!normalized) continue;

      if (compactLower.includes(normalized)) {
        score += test.weight;
        hitKinds.push(test.kind);
      }
    }

    if (score > 0) {
      matches.push({
        score,
        hitKinds,
        cdragonId: hint.cdragonId,
        nameZh: hint.nameZh,
        nameEn: hint.nameEn,
        apiName: hint.apiName,
        icon: hint.icon,
        iconKey: hint.iconKey,
      });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, 5);
}

function extractPossibleObjects(snippetText, aramggId) {
  const findings = [];

  // Loose object-ish substrings containing target id.
  const patterns = [
    new RegExp(`\\{[^{}]{0,500}(?:#?${escapeRegex(aramggId)})[^{}]{0,500}\\}`, "g"),
    new RegExp(`\\[[^\\[\\]]{0,500}(?:#?${escapeRegex(aramggId)})[^\\[\\]]{0,500}\\]`, "g"),
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(snippetText))) {
      findings.push(normalizeText(match[0]).slice(0, 1000));
      if (findings.length >= 5) break;
    }
  }

  return findings;
}

function buildLikelyMap(scoredSnippets) {
  const byAramggId = {};

  for (const item of scoredSnippets) {
    if (!item.matches?.length) continue;

    const best = item.matches[0];
    if (!byAramggId[item.aramggId]) {
      byAramggId[item.aramggId] = {
        aramggId: item.aramggId,
        candidates: [],
      };
    }

    byAramggId[item.aramggId].candidates.push({
      score: best.score,
      hitKinds: best.hitKinds,
      cdragonId: best.cdragonId,
      nameZh: best.nameZh,
      nameEn: best.nameEn,
      apiName: best.apiName,
      icon: best.icon,
      evidenceUrl: item.url,
      evidenceType: item.type,
      snippet: item.snippet.slice(0, 500),
    });
  }

  for (const entry of Object.values(byAramggId)) {
    entry.candidates.sort((a, b) => b.score - a.score);

    const deduped = [];
    const seen = new Set();

    for (const candidate of entry.candidates) {
      const key = `${candidate.cdragonId}-${candidate.apiName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(candidate);
      if (deduped.length >= 10) break;
    }

    entry.candidates = deduped;
    entry.best = deduped[0] || null;
    entry.confidence = entry.best
      ? entry.best.score >= 120
        ? "high"
        : entry.best.score >= 90
        ? "medium"
        : "low"
      : "none";
  }

  return byAramggId;
}

async function main() {
  const cdragon = await loadCdragonHints();

  const pageUrls = [
    `${BASE}/${LANG}`,
    `${BASE}/${LANG}/augments`,
    ...SAMPLE_CHAMPION_KEYS.map((key) => `${BASE}/${LANG}/champion-stats/${key}`),
  ];

  const pages = [];
  const scriptUrls = new Set();
  const inlineChunks = [];
  const fetchErrors = [];

  for (const url of pageUrls) {
    try {
      console.log(`Fetching page: ${url}`);
      const html = await fetchText(url);

      pages.push({
        url,
        length: html.length,
      });

      for (const scriptUrl of collectScriptUrls(html, url)) {
        scriptUrls.add(scriptUrl);
      }

      inlineChunks.push(...collectInlineData(html, url));

      // Also scan page HTML itself.
      inlineChunks.push({
        url,
        type: "html",
        text: html,
      });
    } catch (error) {
      fetchErrors.push({
        url,
        error: error.message,
      });
    }
  }

  const scriptChunks = [];
  const scriptList = [...scriptUrls].slice(0, MAX_SCRIPT_FILES);

  for (const url of scriptList) {
    try {
      console.log(`Fetching script: ${url}`);
      const text = await fetchText(url);

      scriptChunks.push({
        url,
        type: "external-script",
        text,
        length: text.length,
      });
    } catch (error) {
      fetchErrors.push({
        url,
        error: error.message,
      });
    }
  }

  const allChunks = [...inlineChunks, ...scriptChunks];

  const rawSnippets = [];
  for (const chunk of allChunks) {
    rawSnippets.push(...snippetsAroundTargets(chunk.text, chunk.url, chunk.type, TARGET_IDS));
  }

  const scoredSnippets = rawSnippets.map((snippet) => {
    const matches = cdragon.loaded ? scoreSnippet(snippet, cdragon.hints) : [];
    const possibleObjects = extractPossibleObjects(snippet.snippet, snippet.aramggId);

    return {
      ...snippet,
      matches,
      possibleObjects,
    };
  });

  const likelyMap = buildLikelyMap(scoredSnippets);

  const targetSummary = {};
  for (const id of TARGET_IDS) {
    const snippets = scoredSnippets.filter((item) => item.aramggId === id);
    targetSummary[id] = {
      snippetCount: snippets.length,
      matchedSnippetCount: snippets.filter((item) => item.matches?.length).length,
      topCandidate: likelyMap[id]?.best || null,
      confidence: likelyMap[id]?.confidence || "none",
    };
  }

  const payload = {
    source: {
      base: BASE,
      pages: pageUrls,
    },
    scrapedAt: new Date().toISOString(),
    targetIds: TARGET_IDS,
    sampleChampionKeys: SAMPLE_CHAMPION_KEYS,
    cdragon: {
      loaded: cdragon.loaded,
      count: cdragon.count,
      error: cdragon.error || "",
    },
    stats: {
      pagesFetched: pages.length,
      scriptUrlsDiscovered: scriptUrls.size,
      scriptsFetched: scriptChunks.length,
      inlineChunks: inlineChunks.length,
      totalChunksScanned: allChunks.length,
      rawSnippetCount: rawSnippets.length,
      matchedSnippetCount: scoredSnippets.filter((item) => item.matches?.length).length,
    },
    targetSummary,
    likelyMap,
    scoredSnippets: scoredSnippets
      .sort((a, b) => (b.matches?.[0]?.score || 0) - (a.matches?.[0]?.score || 0))
      .slice(0, 300),
    rawSnippets: rawSnippets.slice(0, 300),
    pages,
    scriptsFetched: scriptChunks.map((item) => ({
      url: item.url,
      length: item.length,
    })),
    fetchErrors,
    note:
      "This is a diagnostic file. If likelyMap has high-confidence entries, we can build an aramggId -> CommunityDragon augment bridge. If not, aramgg likely does not expose the mapping in HTML/JS fetched by static requests.",
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Saved ${OUT_PATH}`);
  console.log(`Raw snippets: ${payload.stats.rawSnippetCount}`);
  console.log(`Matched snippets: ${payload.stats.matchedSnippetCount}`);
  console.log(`Script URLs discovered: ${payload.stats.scriptUrlsDiscovered}`);
  console.log(`Scripts fetched: ${payload.stats.scriptsFetched}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
