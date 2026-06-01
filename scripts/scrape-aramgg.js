import * as cheerio from "cheerio";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = "https://aramgg.com";
const LANG_PATH = "/zh-CN";
const HOME_URL = `${BASE}${LANG_PATH}`;
const OUT_PATH = path.join("data", "aramgg-augments.json");
const LIMIT = Number(process.env.CHAMPION_LIMIT || 999);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; personal-aramgg-snapshot/1.0; +https://github.com/)",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status}: ${url}`);
  }

  return await response.text();
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
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

function parseAugments(html) {
  const $ = cheerio.load(html);
  const bodyText = normalizeText($("body").text());

  const start = bodyText.indexOf("海克斯推荐");
  if (start === -1) return [];

  const rest = bodyText.slice(start);
  const endCandidates = [
    rest.indexOf("推荐海克斯组合"),
    rest.indexOf("装备推荐"),
    rest.indexOf("相似英雄推荐"),
  ].filter((index) => index > 0);

  const section = endCandidates.length
    ? rest.slice(0, Math.min(...endCandidates))
    : rest.slice(0, 4000);

  const augments = [];
  const seenRanks = new Set();

  // aramgg text usually looks like:
  // 1 #1356 T 1 60.35% 30.49%
  const rowPattern = /(\d{1,2})\s*#?(\d{3,5})\s*T\s*([1-5])\s*([\d.]+%)\s*([\d.]+%)/g;

  let match;
  while ((match = rowPattern.exec(section)) && augments.length < 20) {
    const rank = Number(match[1]);
    if (rank < 1 || rank > 20 || seenRanks.has(rank)) continue;
    seenRanks.add(rank);

    augments.push({
      rank,
      augmentId: match[2],
      name: `#${match[2]}`,
      tier: `T${match[3]}`,
      winRate: match[4],
      pickRate: match[5],
    });
  }

  return augments.sort((a, b) => a.rank - b.rank).slice(0, 20);
}

async function main() {
  console.log(`Fetching champion list from ${HOME_URL}`);
  const homeHtml = await fetchText(HOME_URL);
  const championLinks = getChampionLinks(homeHtml).slice(0, LIMIT);

  console.log(`Found ${championLinks.length} champion detail pages.`);

  const champions = {};
  const failures = [];

  for (let i = 0; i < championLinks.length; i++) {
    const item = championLinks[i];

    try {
      console.log(`[${i + 1}/${championLinks.length}] ${item.championKey} ${item.url}`);
      const html = await fetchText(item.url);
      const $ = cheerio.load(html);
      const championName = parseChampionName($);
      const augments = parseAugments(html);

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
    champions,
    failures,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Saved ${OUT_PATH}`);
  console.log(`Parsed champions: ${Object.keys(champions).length}`);
  console.log(`Failures or empty pages: ${failures.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
