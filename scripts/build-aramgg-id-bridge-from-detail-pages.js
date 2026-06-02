import * as cheerio from "cheerio";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = "https://aramgg.com";
const LANG = "zh-CN";
const ARAMGG_AUGMENTS_PATH = path.join("data", "aramgg-augments.json");
const CDRAGON_PATH = path.join("data", "cdragon-arena-augments.json");
const OUT_PATH = path.join("data", "aramgg-id-bridge.json");

const SLEEP_MS = Number(process.env.SLEEP_MS || 200);
const MAX_IDS = Number(process.env.MAX_IDS || 9999);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeText(text = "") {
  return String(text).replace(/\s+/g, " ").trim();
}

function cleanAramggName(text = "") {
  return normalizeText(text)
    .replace(/海克斯强化详情.*$/u, "")
    .replace(/海克斯详情.*$/u, "")
    .replace(/\s*[-|｜]\s*胜率.*$/u, "")
    .replace(/\s*[-|｜]\s*aramgg.*$/iu, "")
    .replace(/^首页\s*/u, "")
    .replace(/^海克斯排行\s*/u, "")
    .replace(/Augment\s*#?\d+.*$/iu, "")
    .trim();
}

function normalizeName(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function absoluteUrl(url) {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${BASE}${url}`;
  return `${BASE}/${url}`;
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

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function collectAramggIds() {
  const data = await readJson(ARAMGG_AUGMENTS_PATH);
  const ids = new Set();

  for (const champion of Object.values(data.champions || {})) {
    for (const augment of champion.augments || []) {
      const id = String(augment.augmentId || "").replace("#", "").trim();
      if (/^\d{3,5}$/.test(id)) ids.add(id);
    }
  }

  return [...ids].sort((a, b) => Number(a) - Number(b)).slice(0, MAX_IDS);
}

function buildCdragonLookup(cdragon) {
  const byNormalizedName = new Map();

  for (const item of cdragon.augments || []) {
    const names = [
      item.name,
      item.nameZh,
      item.nameEn,
      item.apiName,
    ].filter(Boolean);

    for (const name of names) {
      const key = normalizeName(name);
      if (!key) continue;
      if (!byNormalizedName.has(key)) byNormalizedName.set(key, item);
    }
  }

  return { byNormalizedName };
}

function parseNameFromBreadcrumbs($, id) {
  const candidates = [];

  // aramgg detail pages expose breadcrumb text like:
  // 首页 / 海克斯排行 / 连拨击锤
  $("nav, ol, ul, header, main, body").each((_, el) => {
    const text = normalizeText($(el).text());
    if (!text.includes("海克斯排行") || !text.includes(`Augment#${id}`) && !text.includes(`Augment #${id}`)) return;

    const re = new RegExp(`海克斯排行\\s+(.{1,40}?)\\s+Augment\\s*#?${id}`, "u");
    const match = text.match(re);
    if (match) {
      const name = cleanAramggName(match[1]);
      if (name && name.length <= 20) candidates.push(name);
    }
  });

  // More direct: collect short text nodes/elements around breadcrumb links.
  $("a, span, div, li, p").each((_, el) => {
    const text = cleanAramggName($(el).text());
    if (!text || text.length > 20) return;
    if (["首页", "海克斯排行", "捐赠", "快速链接", "关于我们"].includes(text)) return;
    if (/^#?\d+$/.test(text)) return;
    if (/胜率|选取率|场次|阶段|版本|语言|ARAMGG|Augment/i.test(text)) return;

    const parentText = normalizeText($(el).parent().text());
    if (parentText.includes("海克斯排行") || parentText.includes(`Augment#${id}`) || parentText.includes(`Augment #${id}`)) {
      candidates.push(text);
    }
  });

  // Return the shortest plausible candidate; breadcrumb names are usually very short.
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0] || "";
}

function parseAramggAugmentDetail(html, id, url) {
  const $ = cheerio.load(html);
  const bodyText = normalizeText($("body").text());
  const title = normalizeText($("title").first().text());

  let name = "";

  // 1) Most reliable: breadcrumb/body around "海克斯排行 ... Augment#id"
  name = parseNameFromBreadcrumbs($, id);

  // 2) Body regex fallback.
  if (!name) {
    const patterns = [
      new RegExp(`海克斯排行\\s+(.{1,40}?)\\s+Augment\\s*#?${id}`, "u"),
      new RegExp(`(.{1,40}?)\\s+Augment\\s*#?${id}`, "u"),
    ];

    for (const pattern of patterns) {
      const match = bodyText.match(pattern);
      if (match) {
        const candidate = cleanAramggName(match[1]);
        if (candidate && candidate.length <= 20 && !candidate.includes("首页")) {
          name = candidate;
          break;
        }
      }
    }
  }

  // 3) Title fallback: "连拨击锤海克斯强化详情 - ..."
  if (!name) {
    const titleMatch = title.match(/^(.+?)海克斯强化详情/u);
    if (titleMatch) name = cleanAramggName(titleMatch[1]);
  }

  // 4) H1/H2 fallback.
  if (!name) {
    const headings = $("h1,h2,h3")
      .map((_, el) => cleanAramggName($(el).text()))
      .get()
      .filter(Boolean);

    for (const heading of headings) {
      if (
        heading &&
        !heading.includes("Augment") &&
        !heading.includes(`#${id}`) &&
        !heading.includes("海克斯") &&
        heading.length <= 20
      ) {
        name = heading;
        break;
      }
    }
  }

  const rarityMatch = bodyText.match(/(白银|黄金|棱彩)\s*T\s*([1-5])/);
  const winRateMatch = bodyText.match(/胜率\s*([\d.]+%)/);
  const pickRateMatch = bodyText.match(/选取率\s*([\d.]+%)/);
  const gamesMatch = bodyText.match(/场次\s*([\d,]+)/);

  let image = "";
  $("img").each((_, img) => {
    if (image) return;
    const src = $(img).attr("src") || $(img).attr("data-src") || "";
    const alt = normalizeText($(img).attr("alt") || "");
    const full = absoluteUrl(src);
    const lower = full.toLowerCase();

    if (!src) return;
    if (alt === name || lower.includes("augment") || lower.includes("cherry") || lower.includes("hextech")) {
      image = full;
    }
  });

  return {
    aramggId: id,
    aramggUrl: url,
    nameZh: name,
    rarity: rarityMatch?.[1] || "",
    tier: rarityMatch ? `T${rarityMatch[2]}` : "",
    winRate: winRateMatch?.[1] || "",
    pickRate: pickRateMatch?.[1] || "",
    games: gamesMatch?.[1] || "",
    imageFromAramgg: image,
    title,
  };
}

async function main() {
  const ids = await collectAramggIds();
  const cdragon = await readJson(CDRAGON_PATH);
  const cdragonLookup = buildCdragonLookup(cdragon);

  const byAramggId = {};
  const failures = [];
  const unmatched = [];

  console.log(`Found ${ids.length} aramgg augment ids.`);

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const url = `${BASE}/${LANG}/augments/${id}`;

    try {
      console.log(`[${i + 1}/${ids.length}] ${url}`);
      const html = await fetchText(url);
      const detail = parseAramggAugmentDetail(html, id, url);

      const normalized = normalizeName(detail.nameZh);
      const cdragonInfo = normalized ? cdragonLookup.byNormalizedName.get(normalized) : null;

      byAramggId[id] = {
        aramggId: id,
        source: "aramgg-detail-page",
        confidence: detail.nameZh ? "official-page" : "name-missing",
        score: detail.nameZh ? 10000 : 0,
        cdragonId: cdragonInfo?.id || "",
        nameZh: detail.nameZh || `#${id}`,
        nameEn: cdragonInfo?.nameEn || "",
        name: cdragonInfo?.name || detail.nameZh || `#${id}`,
        apiName: cdragonInfo?.apiName || "",
        icon: cdragonInfo?.icon || detail.imageFromAramgg || "",
        rarity: detail.rarity || cdragonInfo?.rarity || "",
        tier: detail.tier || "",
        winRateOverall: detail.winRate || "",
        pickRateOverall: detail.pickRate || "",
        games: detail.games || "",
        aramggUrl: detail.aramggUrl,
        matchedCdragon: Boolean(cdragonInfo),
        matchMethod: cdragonInfo ? "exact-normalized-name" : "none",
        title: detail.title,
      };

      if (!detail.nameZh || !cdragonInfo) {
        unmatched.push({
          aramggId: id,
          nameZh: detail.nameZh,
          reason: !detail.nameZh ? "No name parsed from detail page" : "No exact CommunityDragon name match",
          url,
        });
      }

      await sleep(SLEEP_MS);
    } catch (error) {
      failures.push({
        aramggId: id,
        url,
        reason: error.message,
      });

      byAramggId[id] = {
        aramggId: id,
        source: "aramgg-detail-page",
        confidence: "fetch-failed",
        score: 0,
        cdragonId: "",
        nameZh: `#${id}`,
        nameEn: "",
        name: `#${id}`,
        apiName: "",
        icon: "",
        rarity: "",
        aramggUrl: url,
        matchedCdragon: false,
        matchMethod: "none",
      };
    }
  }

  const payload = {
    source: {
      aramggAugments: ARAMGG_AUGMENTS_PATH,
      cdragon: CDRAGON_PATH,
      detailPagePattern: `${BASE}/${LANG}/augments/{id}`,
    },
    builtAt: new Date().toISOString(),
    method: "official-aramgg-augment-detail-pages-v2-clean-name",
    mappedCount: Object.keys(byAramggId).length,
    matchedCdragonCount: Object.values(byAramggId).filter((item) => item.matchedCdragon).length,
    iconCount: Object.values(byAramggId).filter((item) => item.icon).length,
    failureCount: failures.length,
    unmatchedCount: unmatched.length,
    byAramggId,
    unmatched,
    failures,
    note:
      "Accurate bridge table built from aramgg augment detail pages. v2 cleans names from breadcrumb/body/title to avoid title suffix contamination.",
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Saved ${OUT_PATH}`);
  console.log(`Mapped: ${payload.mappedCount}`);
  console.log(`Matched CDragon: ${payload.matchedCdragonCount}`);
  console.log(`Icons: ${payload.iconCount}`);
  console.log(`Failures: ${payload.failureCount}`);
  console.log(`Unmatched: ${payload.unmatchedCount}`);

  if (payload.mappedCount === 0) {
    throw new Error("No aramgg detail-page mappings generated.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
