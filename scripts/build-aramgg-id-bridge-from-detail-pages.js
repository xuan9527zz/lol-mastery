import * as cheerio from "cheerio";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = "https://aramgg.com";
const LANG = "zh-CN";
const ARAMGG_AUGMENTS_PATH = path.join("data", "aramgg-augments.json");
const APEX_PATH = path.join("data", "apexlol-hextech-dictionary.json");
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
    .replace(/强化详情.*$/u, "")
    .replace(/详情.*$/u, "")
    .replace(/\s*[-|｜]\s*胜率.*$/u, "")
    .replace(/\s*[-|｜]\s*最佳英雄搭配.*$/u, "")
    .replace(/\s*[-|｜]\s*aramgg.*$/iu, "")
    .replace(/\s*\|\s*aramgg.*$/iu, "")
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

function normalizeSlug(text = "") {
  return String(text).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function looseNameKey(text = "") {
  return normalizeName(text)
    .replace(/擊/g, "击")
    .replace(/鎚/g, "锤")
    .replace(/連/g, "连")
    .replace(/撥/g, "拨")
    .replace(/雙/g, "双")
    .replace(/發/g, "发")
    .replace(/亂/g, "乱")
    .replace(/療/g, "疗");
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

async function readJsonMaybe(filePath, fallback = null) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function collectAramggIds() {
  const data = await readJsonMaybe(ARAMGG_AUGMENTS_PATH, { champions: {} });
  const ids = new Set();

  for (const champion of Object.values(data.champions || {})) {
    for (const augment of champion.augments || []) {
      const id = String(augment.augmentId || "").replace("#", "").trim();
      if (/^\d{3,5}$/.test(id)) ids.add(id);
    }
  }

  return [...ids].sort((a, b) => Number(a) - Number(b)).slice(0, MAX_IDS);
}

function buildApexLookup(apex) {
  const byName = new Map();

  for (const item of apex.hextech || []) {
    const keys = [
      item.nameZh,
      ...(item.aliasesZh || []),
    ].filter(Boolean);

    for (const key of keys) {
      const exact = normalizeName(key);
      const loose = looseNameKey(key);
      if (exact && !byName.has(exact)) byName.set(exact, item);
      if (loose && !byName.has(loose)) byName.set(loose, item);
    }
  }

  return { byName };
}

function buildCdragonLookup(cdragon) {
  const byName = new Map();
  const bySlug = new Map();

  for (const item of cdragon.augments || []) {
    const names = [
      item.name,
      item.nameZh,
      item.nameEn,
      item.apiName,
    ].filter(Boolean);

    for (const name of names) {
      const exact = normalizeName(name);
      const loose = looseNameKey(name);
      if (exact && !byName.has(exact)) byName.set(exact, item);
      if (loose && !byName.has(loose)) byName.set(loose, item);
    }

    const slugKeys = [
      item.apiName,
      item.nameEn,
      item.icon,
    ].filter(Boolean);

    for (const slug of slugKeys) {
      const key = normalizeSlug(slug);
      if (key && !bySlug.has(key)) bySlug.set(key, item);
    }
  }

  return { byName, bySlug, augments: cdragon.augments || [] };
}

function matchApex(apexLookup, name) {
  const exact = apexLookup.byName.get(normalizeName(name));
  if (exact) return exact;

  const loose = apexLookup.byName.get(looseNameKey(name));
  if (loose) return loose;

  return null;
}

function matchCdragon(cdragonLookup, name, apexItem) {
  // 1) Try Apex slug against CDragon apiName/icon/nameEn.
  if (apexItem?.slug) {
    const slug = normalizeSlug(apexItem.slug);
    const bySlug = cdragonLookup.bySlug.get(slug);
    if (bySlug) return { item: bySlug, method: "apex-slug-to-cdragon" };

    // contains matching, e.g. doubletap vs augmenticons/doubletap_large.png
    const candidates = cdragonLookup.augments.filter((item) => {
      const values = [item.apiName, item.nameEn, item.icon].map(normalizeSlug);
      return values.some((value) => value && (value.includes(slug) || slug.includes(value)));
    });

    if (candidates.length === 1) {
      return { item: candidates[0], method: "apex-slug-contains-cdragon" };
    }
  }

  // 2) Try Chinese names.
  const exact = cdragonLookup.byName.get(normalizeName(name));
  if (exact) return { item: exact, method: "cdragon-exact-name" };

  const loose = cdragonLookup.byName.get(looseNameKey(name));
  if (loose) return { item: loose, method: "cdragon-loose-name" };

  return { item: null, method: "none" };
}

function parseAramggName(html, id) {
  const $ = cheerio.load(html);
  const title = normalizeText($("title").first().text());
  const body = normalizeText($("body").text());

  const titleMatch = title.match(/^(.+?)海克斯强化详情/u);
  if (titleMatch) {
    const name = cleanAramggName(titleMatch[1]);
    if (name) return { name, title, body };
  }

  const bodyPatterns = [
    new RegExp(`海克斯排行\\s+(.{1,60}?)\\s+Augment\\s*#?${id}`, "u"),
    new RegExp(`(.{1,60}?)\\s+Augment\\s*#?${id}`, "u"),
  ];

  for (const pattern of bodyPatterns) {
    const match = body.match(pattern);
    if (match) {
      const name = cleanAramggName(match[1]);
      if (name && name.length <= 20 && !name.includes("首页")) {
        return { name, title, body };
      }
    }
  }

  const h1 = cleanAramggName($("h1").first().text());
  if (h1) return { name: h1, title, body };

  return { name: "", title, body };
}

function parseRates(body) {
  const rarityMatch = body.match(/(白银|黄金|棱彩)\s*T\s*([1-5])/);
  const winRateMatch = body.match(/胜率\s*([\d.]+%)/);
  const pickRateMatch = body.match(/选取率\s*([\d.]+%)/);
  const gamesMatch = body.match(/场次\s*([\d,]+)/);

  return {
    rarity: rarityMatch?.[1] || "",
    tier: rarityMatch ? `T${rarityMatch[2]}` : "",
    winRateOverall: winRateMatch?.[1] || "",
    pickRateOverall: pickRateMatch?.[1] || "",
    games: gamesMatch?.[1] || "",
  };
}

async function main() {
  const ids = await collectAramggIds();
  const apex = await readJsonMaybe(APEX_PATH, { hextech: [] });
  const cdragon = await readJsonMaybe(CDRAGON_PATH, { augments: [] });

  const apexLookup = buildApexLookup(apex);
  const cdragonLookup = buildCdragonLookup(cdragon);

  const byAramggId = {};
  const failures = [];
  const unmatched = [];

  console.log(`Found ${ids.length} aramgg augment ids.`);
  console.log(`ApexLoL entries: ${(apex.hextech || []).length}`);
  console.log(`CommunityDragon entries: ${(cdragon.augments || []).length}`);

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const url = `${BASE}/${LANG}/augments/${id}`;

    try {
      console.log(`[${i + 1}/${ids.length}] ${url}`);
      const html = await fetchText(url);
      const parsed = parseAramggName(html, id);
      const rates = parseRates(parsed.body);

      const apexItem = parsed.name ? matchApex(apexLookup, parsed.name) : null;
      const cdragonMatch = parsed.name ? matchCdragon(cdragonLookup, parsed.name, apexItem) : { item: null, method: "none" };
      const cdragonInfo = cdragonMatch.item;

      const icon = apexItem?.image || cdragonInfo?.icon || "";

      byAramggId[id] = {
        aramggId: id,
        source: "aramgg-detail-page-apexlol-first",
        confidence: parsed.name ? "official-page" : "name-missing",
        score: parsed.name ? 10000 : 0,
        cdragonId: cdragonInfo?.id || "",
        nameZh: parsed.name || `#${id}`,
        nameEn: cdragonInfo?.nameEn || "",
        name: parsed.name || cdragonInfo?.name || `#${id}`,
        apiName: cdragonInfo?.apiName || "",
        icon,
        rarity: rates.rarity || cdragonInfo?.rarity || apexItem?.tier || "",
        tier: rates.tier || "",
        winRateOverall: rates.winRateOverall,
        pickRateOverall: rates.pickRateOverall,
        games: rates.games,
        aramggUrl: url,
        matchedApex: Boolean(apexItem),
        apexSlug: apexItem?.slug || "",
        apexUrl: apexItem?.url || "",
        apexDescription: apexItem?.description || "",
        matchedCdragon: Boolean(cdragonInfo),
        matchMethod: apexItem
          ? cdragonInfo
            ? `apex+${cdragonMatch.method}`
            : "apex-only"
          : cdragonMatch.method,
        title: parsed.title,
      };

      if (!parsed.name || !apexItem && !cdragonInfo) {
        unmatched.push({
          aramggId: id,
          nameZh: parsed.name,
          reason: !parsed.name ? "No name parsed from aramgg detail page" : "No ApexLoL or CommunityDragon match",
          url,
        });
      }

      await sleep(200);
    } catch (error) {
      failures.push({
        aramggId: id,
        url,
        reason: error.message,
      });

      byAramggId[id] = {
        aramggId: id,
        source: "aramgg-detail-page-apexlol-first",
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
        matchedApex: false,
        matchedCdragon: false,
        matchMethod: "none",
      };
    }
  }

  const values = Object.values(byAramggId);
  const payload = {
    source: {
      aramggAugments: ARAMGG_AUGMENTS_PATH,
      apexlol: APEX_PATH,
      cdragon: CDRAGON_PATH,
      detailPagePattern: `${BASE}/${LANG}/augments/{id}`,
    },
    builtAt: new Date().toISOString(),
    method: "aramgg-detail-page-name-apexlol-first-communitydragon-second",
    mappedCount: values.length,
    matchedApexCount: values.filter((item) => item.matchedApex).length,
    matchedCdragonCount: values.filter((item) => item.matchedCdragon).length,
    iconCount: values.filter((item) => item.icon).length,
    failureCount: failures.length,
    unmatchedCount: unmatched.length,
    byAramggId,
    unmatched,
    failures,
    note:
      "Accurate bridge from aramgg id detail pages. Name/icon mapping prioritizes ApexLoL, then falls back to CommunityDragon.",
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Saved ${OUT_PATH}`);
  console.log(`Mapped: ${payload.mappedCount}`);
  console.log(`Matched ApexLoL: ${payload.matchedApexCount}`);
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
