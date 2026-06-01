import * as cheerio from "cheerio";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = "https://aramgg.com";
const LANG_PATH = "/zh-CN";
const HOME_URL = `${BASE}${LANG_PATH}`;
const OUT_PATH = path.join("data", "aramgg-augments.json");
const CDRAGON_PATH = path.join("data", "cdragon-arena-augments.json");
const LIMIT = Number(process.env.CHAMPION_LIMIT || 999);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function normalizeText(text = "") {
  return text.replace(/\s+/g, " ").trim();
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

function getChampionLinks(homeHtml) {
  const $ = cheerio.load(homeHtml);
  const map = new Map();

  $("a[href*='/zh-CN/champion-stats/']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const match = href.match(/\/zh-CN\/champion-stats\/(\d+)/);
    if (!match) return;

    const key = match[1];
    const url = href.startsWith("http") ? href : `${BASE}${href}`;
    const text = normalizeText($(el).text());

    if (!map.has(key)) {
      map.set(key, {
        championKey: key,
        url,
        linkText: text,
      });
    }
  });

  return [...map.values()];
}

function parseChampionName($) {
  const title = $("title").first().text();
  const match = title.match(/^(.+?)海克斯强化推荐/);
  if (match) return match[1].trim();

  const h1 = $("h1").first().text().trim();
  return h1 || "";
}

async function loadCdragon() {
  try {
    const raw = await readFile(CDRAGON_PATH, "utf8");
    const data = JSON.parse(raw);

    const byIconKey = {};

    for (const item of data.augments || []) {
      const keys = [
        normalizeIconKey(item.icon),
        normalizeIconKey(item.apiName),
        normalizeIconKey(item.nameEn),
      ].filter(Boolean);

      for (const key of keys) {
        if (!byIconKey[key]) byIconKey[key] = item;
      }
    }

    for (const file of data.iconFiles || []) {
      const key = normalizeIconKey(file.fileName || file.url);
      if (!key) continue;

      const matched =
        Object.values(data.byId || {}).find((item) => normalizeIconKey(item.icon) === key) ||
        Object.values(data.byApiName || {}).find((item) => normalizeIconKey(item.icon) === key);

      if (matched && !byIconKey[key]) byIconKey[key] = matched;
    }

    return {
      data,
      byIconKey,
    };
  } catch (error) {
    console.warn(`Could not load ${CDRAGON_PATH}: ${error.message}`);
    return {
      data: null,
      byIconKey: {},
    };
  }
}

function findLikelyIcon($, el) {
  const candidates = [];

  function collect(node, weight = 0) {
    const $node = $(node);

    $node.find("img").each((_, img) => {
      const $img = $(img);
      const src =
        $img.attr("src") ||
        $img.attr("data-src") ||
        $img.attr("data-nimg") ||
        "";

      if (!src) return;
      const url = absoluteUrl(src);

      let score = weight;
      const lower = url.toLowerCase();

      if (lower.includes("augment")) score += 100;
      if (lower.includes("cherry")) score += 80;
      if (lower.includes("hextech")) score += 50;
      if (lower.includes("_large") || lower.includes("_small")) score += 20;
      if (lower.includes("champion")) score -= 80;
      if (lower.includes("tiles")) score -= 60;

      candidates.push({ url, score });
    });

    const style = $node.attr("style") || "";
    const styleMatch = style.match(/url\(["']?([^"')]+)["']?\)/i);
    if (styleMatch) {
      const url = absoluteUrl(styleMatch[1]);
      let score = weight + 10;
      const lower = url.toLowerCase();

      if (lower.includes("augment")) score += 100;
      if (lower.includes("cherry")) score += 80;
      if (lower.includes("hextech")) score += 50;
      if (lower.includes("champion")) score -= 80;

      candidates.push({ url, score });
    }
  }

  collect(el, 40);

  let parent = $(el).parent();
  for (let depth = 0; depth < 5 && parent.length; depth++) {
    collect(parent, 30 - depth * 5);
    parent = parent.parent();
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  if (!best || best.score < 40) return "";
  return best.url;
}

function parseAugmentsByDom(html, cdragonByIconKey) {
  const $ = cheerio.load(html);
  const bodyText = normalizeText($("body").text());
  const start = bodyText.indexOf("海克斯推荐");
  const endCandidates = [
    bodyText.indexOf("推荐海克斯组合", start),
    bodyText.indexOf("装备推荐", start),
    bodyText.indexOf("相似英雄推荐", start),
  ].filter((index) => index > start);

  const sectionEnd = endCandidates.length ? Math.min(...endCandidates) : start + 5000;
  const section = start >= 0 ? bodyText.slice(start, sectionEnd) : bodyText;

  const rowPattern = /(\d{1,2})\s*#?(\d{3,5})\s*T\s*([1-5])\s*([\d.]+%)\s*([\d.]+%)/g;
  const rows = [];
  let match;

  while ((match = rowPattern.exec(section)) && rows.length < 20) {
    const rank = Number(match[1]);
    if (rank < 1 || rank > 20) continue;

    rows.push({
      rank,
      augmentId: match[2],
      tier: `T${match[3]}`,
      winRate: match[4],
      pickRate: match[5],
    });
  }

  // Try to enrich each row by finding a DOM element containing the augment id.
  for (const row of rows) {
    let icon = "";
    let matched = null;

    const selectorCandidates = [
      `*:contains("#${row.augmentId}")`,
      `*:contains("${row.augmentId}")`,
    ];

    for (const selector of selectorCandidates) {
      const elements = $(selector)
        .filter((_, el) => {
          const text = normalizeText($(el).text());
          return (
            text.includes(`#${row.augmentId}`) ||
            new RegExp(`(^|\\s)${row.augmentId}(\\s|$)`).test(text)
          );
        })
        .toArray();

      // Prefer the smallest element containing both id and win rate.
      elements.sort((a, b) => normalizeText($(a).text()).length - normalizeText($(b).text()).length);

      for (const el of elements.slice(0, 10)) {
        const text = normalizeText($(el).text());
        if (!text.includes(row.winRate) && !text.includes(row.pickRate)) continue;

        icon = findLikelyIcon($, el);
        if (icon) break;
      }

      if (icon) break;
    }

    const iconKey = normalizeIconKey(icon);
    if (iconKey && cdragonByIconKey[iconKey]) {
      matched = cdragonByIconKey[iconKey];
    }

    row.icon = matched?.icon || icon || "";
    row.name = matched?.nameZh || matched?.name || `#${row.augmentId}`;
    row.nameEn = matched?.nameEn || "";
    row.cdragonId = matched?.id || "";
    row.matchKey = iconKey || "";
    row.matchSource = matched ? "icon-filename" : icon ? "aramgg-icon-only" : "none";
  }

  return rows.sort((a, b) => a.rank - b.rank).slice(0, 20);
}

async function main() {
  const cdragon = await loadCdragon();

  console.log(`Fetching champion list from ${HOME_URL}`);
  const homeHtml = await fetchText(HOME_URL);
  const championLinks = getChampionLinks(homeHtml).slice(0, LIMIT);

  console.log(`Found ${championLinks.length} champion detail pages.`);
  console.log(`CDragon loaded: ${Boolean(cdragon.data)}, icon keys: ${Object.keys(cdragon.byIconKey).length}`);

  const champions = {};
  const failures = [];
  let enrichedCount = 0;
  let iconOnlyCount = 0;

  for (let i = 0; i < championLinks.length; i++) {
    const item = championLinks[i];

    try {
      console.log(`[${i + 1}/${championLinks.length}] ${item.championKey} ${item.url}`);
      const html = await fetchText(item.url);
      const $ = cheerio.load(html);
      const championName = parseChampionName($);
      const augments = parseAugmentsByDom(html, cdragon.byIconKey);

      enrichedCount += augments.filter((a) => a.matchSource === "icon-filename").length;
      iconOnlyCount += augments.filter((a) => a.matchSource === "aramgg-icon-only").length;

      champions[item.championKey] = {
        championKey: item.championKey,
        championName,
        url: item.url,
        augments,
      };

      if (augments.length === 0) {
        failures.push({
          championKey: item.championKey,
          url: item.url,
          reason: "No augment rows parsed",
        });
      }

      await sleep(250);
    } catch (error) {
      failures.push({
        championKey: item.championKey,
        url: item.url,
        reason: error.message,
      });
      console.warn(`Failed ${item.url}: ${error.message}`);
    }
  }

  const payload = {
    source: HOME_URL,
    scrapedAt: new Date().toISOString(),
    championCount: Object.keys(champions).length,
    bridge: {
      cdragonLoaded: Boolean(cdragon.data),
      cdragonIconKeys: Object.keys(cdragon.byIconKey).length,
      enrichedByIconFilename: enrichedCount,
      aramggIconOnly: iconOnlyCount,
    },
    champions,
    failures,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Saved ${OUT_PATH}`);
  console.log(`Parsed champions: ${Object.keys(champions).length}`);
  console.log(`Failures or empty pages: ${failures.length}`);
  console.log(`Enriched by icon filename: ${enrichedCount}`);
  console.log(`Aramgg icon only: ${iconOnlyCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
