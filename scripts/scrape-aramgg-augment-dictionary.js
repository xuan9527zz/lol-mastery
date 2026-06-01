import * as cheerio from "cheerio";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = "https://aramgg.com";
const AUGMENTS_URL = `${BASE}/zh-CN/augments`;
const OUT_PATH = path.join("data", "aramgg-augment-dictionary.json");

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

function extractUrlFromStyle(style = "") {
  const match = style.match(/url\(["']?([^"')]+)["']?\)/i);
  return match ? absoluteUrl(match[1]) : "";
}

function extractNumericId(...values) {
  for (const value of values) {
    if (!value) continue;
    const matches = String(value).match(/\d{3,5}/g);
    if (matches?.length) return matches[matches.length - 1];
  }
  return "";
}

function slugifyName(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; personal-aramgg-augment-dictionary/1.0; +https://github.com/)",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status}: ${url}`);
  }

  return await response.text();
}

function findBestImage($, el, augmentName) {
  const candidates = [];

  function collectFrom(node, weight = 0) {
    const $node = $(node);

    $node.find("img").each((_, img) => {
      const $img = $(img);
      const alt = normalizeText($img.attr("alt") || "");
      const src =
        $img.attr("src") ||
        $img.attr("data-src") ||
        $img.attr("data-nimg") ||
        "";

      if (!src) return;

      const fullSrc = absoluteUrl(src);
      let score = weight;

      if (alt === augmentName) score += 100;
      if (fullSrc.toLowerCase().includes("augment")) score += 50;
      if (fullSrc.toLowerCase().includes("arena")) score += 20;
      if (fullSrc.toLowerCase().includes("champion")) score -= 40;
      if (alt && alt !== augmentName) score -= 15;

      candidates.push({
        src: fullSrc,
        alt,
        score,
      });
    });

    const styleUrl = extractUrlFromStyle($node.attr("style") || "");
    if (styleUrl) {
      candidates.push({
        src: styleUrl,
        alt: "",
        score: weight + (styleUrl.toLowerCase().includes("augment") ? 50 : 0),
      });
    }
  }

  collectFrom(el, 30);

  let parent = $(el).parent();
  for (let depth = 0; depth < 4 && parent.length; depth++) {
    collectFrom(parent, 20 - depth * 5);
    parent = parent.parent();
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.src || "";
}

function parseAugmentsFromAnchors(html) {
  const $ = cheerio.load(html);
  const byId = {};
  const list = [];

  $("a").each((_, el) => {
    const text = normalizeText($(el).text());

    // Examples:
    // 质变：棱彩阶 黄金 64.38% 选取率 1.47%
    // 珠光护手 棱彩 60.59% 选取率 1.38%
    const match = text.match(/^(.+?)\s+(棱彩|黄金|白银)\s+([\d.]+%)\s+选取率\s+([\d.]+%)$/);
    if (!match) return;

    const [, name, rarity, winRate, pickRate] = match;
    const href = absoluteUrl($(el).attr("href") || "");
    const image = findBestImage($, el, name);
    const augmentId = extractNumericId(href, image) || slugifyName(name);

    if (!augmentId || byId[augmentId]) return;

    const item = {
      augmentId,
      name,
      rarity,
      winRate,
      pickRate,
      href,
      image,
      imageFound: Boolean(image),
      idConfidence: /^\d+$/.test(augmentId) ? "numeric" : "name-slug",
    };

    byId[augmentId] = item;
    list.push(item);
  });

  return { list, byId };
}

function parsePossibleJsonData(html) {
  // Optional backup parser: scan script JSON for objects that may contain augment info.
  // It won't break if the site changes; it just adds extra candidates when available.
  const $ = cheerio.load(html);
  const found = [];

  function walk(value) {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }

    const keys = Object.keys(value);
    const name =
      value.name ||
      value.name_zh ||
      value.nameZh ||
      value.title ||
      value.displayName ||
      "";

    const id =
      value.augmentId ||
      value.id ||
      value.key ||
      value.apiName ||
      value.slug ||
      "";

    const image =
      value.image ||
      value.icon ||
      value.iconUrl ||
      value.imageUrl ||
      value.src ||
      "";

    if (name && (id || image) && keys.some((key) => /augment|rarity|tier|win|pick|icon|image/i.test(key))) {
      found.push({
        augmentId: extractNumericId(id, image) || String(id || slugifyName(name)),
        name: String(name),
        image: absoluteUrl(String(image || "")),
        rawId: id,
      });
    }

    for (const child of Object.values(value)) walk(child);
  }

  $("script").each((_, script) => {
    const text = $(script).contents().text().trim();
    if (!text || (!text.startsWith("{") && !text.startsWith("["))) return;

    try {
      walk(JSON.parse(text));
    } catch {
      // ignore non-json scripts
    }
  });

  return found;
}

async function main() {
  console.log(`Fetching ${AUGMENTS_URL}`);
  const html = await fetchText(AUGMENTS_URL);

  const fromAnchors = parseAugmentsFromAnchors(html);
  const fromJson = parsePossibleJsonData(html);

  const byId = { ...fromAnchors.byId };

  for (const item of fromJson) {
    if (!item.augmentId) continue;

    if (!byId[item.augmentId]) {
      byId[item.augmentId] = {
        augmentId: item.augmentId,
        name: item.name,
        rarity: "",
        winRate: "",
        pickRate: "",
        href: "",
        image: item.image,
        imageFound: Boolean(item.image),
        idConfidence: /^\d+$/.test(item.augmentId) ? "numeric-json" : "json",
      };
    } else if (!byId[item.augmentId].image && item.image) {
      byId[item.augmentId].image = item.image;
      byId[item.augmentId].imageFound = true;
    }
  }

  const augments = Object.values(byId).sort((a, b) => {
    const aNum = Number(a.augmentId);
    const bNum = Number(b.augmentId);

    if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });

  const payload = {
    source: AUGMENTS_URL,
    scrapedAt: new Date().toISOString(),
    augmentCount: augments.length,
    imageCount: augments.filter((item) => item.imageFound).length,
    note:
      "This file is a one-time personal snapshot from aramgg augment ranking page. Some images may be empty if the page does not expose augment icons directly.",
    augments,
    byId,
    byName: Object.fromEntries(augments.map((item) => [item.name, item])),
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Saved ${OUT_PATH}`);
  console.log(`Augments: ${payload.augmentCount}`);
  console.log(`Images found: ${payload.imageCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
