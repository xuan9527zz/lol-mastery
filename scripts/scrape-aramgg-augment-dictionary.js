import * as cheerio from "cheerio";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = "https://aramgg.com";
const AUGMENTS_URL = `${BASE}/zh-CN/augments`;
const OUT_PATH = path.join("data", "aramgg-augment-dictionary.json");

function normalizeText(text = "") {
  return text.replace(/\s+/g, " ").trim();
}

function compactText(text = "") {
  return normalizeText(text).replace(/\s+/g, "");
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
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status}: ${url}`);
  }

  return await response.text();
}

function findPossibleImage($, el, augmentName) {
  // aramgg /augments currently mostly exposes recommended champion icons,
  // not augment icons. This function keeps a safe image field only when a
  // nearby image alt matches the augment name or URL looks augment-like.
  const candidates = [];

  function collect(node, weight = 0) {
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
      if (/augment|augments|perk|arena/i.test(fullSrc)) score += 60;
      if (alt && alt !== augmentName) score -= 80; // usually champion icons

      candidates.push({ src: fullSrc, alt, score });
    });

    const styleUrl = extractUrlFromStyle($node.attr("style") || "");
    if (styleUrl) {
      let score = weight;
      if (/augment|augments|perk|arena/i.test(styleUrl)) score += 60;
      candidates.push({ src: styleUrl, alt: "", score });
    }
  }

  collect(el, 30);
  let parent = $(el).parent();
  for (let depth = 0; depth < 3 && parent.length; depth++) {
    collect(parent, 20 - depth * 5);
    parent = parent.parent();
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  if (!best || best.score < 50) return "";
  return best.src;
}

function parseFromAnchorTexts($) {
  const byName = new Map();

  $("a, button, div, li").each((_, el) => {
    const raw = normalizeText($(el).text());
    const compact = raw.replace(/\s+/g, "");

    // This handles both:
    // 质变：棱彩阶 黄金 64.38% 选取率 1.47%
    // 质变：棱彩阶黄金64.38%选取率1.47%
    const match = compact.match(/^(.+?)(棱彩|黄金|白银)([\d.]+%)选取率([\d.]+%)$/);
    if (!match) return;

    const [, name, rarity, winRate, pickRate] = match;
    if (!name || name.length > 40) return;

    const href = absoluteUrl($(el).attr("href") || "");
    const image = findPossibleImage($, el, name);
    const augmentId = extractNumericId(href, image) || slugifyName(name);

    if (byName.has(name)) return;

    byName.set(name, {
      augmentId,
      name,
      rarity,
      winRate,
      pickRate,
      href,
      image,
      imageFound: Boolean(image),
      idConfidence: /^\d+$/.test(augmentId) ? "numeric" : "name-slug",
      parseSource: "element-text",
    });
  });

  return [...byName.values()];
}

function parseFromBodyText($) {
  const body = normalizeText($("body").text());
  const results = [];
  const seen = new Set();

  // Work section by section. Each augment row is followed by 5 champion names,
  // so we avoid a giant greedy regex by slicing between rarity/rate patterns.
  const pattern = /([\p{Script=Han}A-Za-z0-9：:！!、·.\-+（）() ]{1,40}?)(棱彩|黄金|白银)\s*([\d.]+%)\s*选取率\s*([\d.]+%)/gu;

  let match;
  while ((match = pattern.exec(body))) {
    let name = normalizeText(match[1]);

    // Remove tier headers if they get attached.
    name = name.replace(/^.*?(T\s*\d\s*T\d\s*\d+个\s*(收起|展开)?\s*)/, "").trim();

    if (!name || name.length > 30) continue;
    if (seen.has(name)) continue;

    seen.add(name);
    results.push({
      augmentId: slugifyName(name),
      name,
      rarity: match[2],
      winRate: match[3],
      pickRate: match[4],
      href: "",
      image: "",
      imageFound: false,
      idConfidence: "name-slug",
      parseSource: "body-text",
    });
  }

  return results;
}

function mergeAugments(primary, fallback) {
  const byName = new Map();

  for (const item of [...primary, ...fallback]) {
    if (!item.name) continue;

    if (!byName.has(item.name)) {
      byName.set(item.name, item);
      continue;
    }

    const old = byName.get(item.name);
    byName.set(item.name, {
      ...old,
      ...Object.fromEntries(Object.entries(item).filter(([, value]) => value !== "" && value !== false)),
      image: old.image || item.image || "",
      imageFound: Boolean(old.image || item.image),
      href: old.href || item.href || "",
      augmentId: /^\d+$/.test(old.augmentId) ? old.augmentId : item.augmentId || old.augmentId,
      idConfidence: /^\d+$/.test(old.augmentId) ? old.idConfidence : item.idConfidence || old.idConfidence,
    });
  }

  return [...byName.values()];
}

async function main() {
  console.log(`Fetching ${AUGMENTS_URL}`);
  const html = await fetchText(AUGMENTS_URL);
  const $ = cheerio.load(html);

  const fromElements = parseFromAnchorTexts($);
  const fromBody = parseFromBodyText($);
  const augments = mergeAugments(fromElements, fromBody).sort((a, b) => {
    const order = { 棱彩: 0, 黄金: 1, 白银: 2 };
    const rarityDiff = (order[a.rarity] ?? 99) - (order[b.rarity] ?? 99);
    if (rarityDiff !== 0) return rarityDiff;

    const aWin = Number(String(a.winRate).replace("%", ""));
    const bWin = Number(String(b.winRate).replace("%", ""));
    return bWin - aWin;
  });

  const byId = Object.fromEntries(augments.map((item) => [item.augmentId, item]));
  const byName = Object.fromEntries(augments.map((item) => [item.name, item]));

  const payload = {
    source: AUGMENTS_URL,
    scrapedAt: new Date().toISOString(),
    augmentCount: augments.length,
    imageCount: augments.filter((item) => item.imageFound).length,
    note:
      "This is a one-time personal snapshot from aramgg augment ranking page. The page exposes augment names/rates, but it may not expose augment icons; if imageCount is 0, icons need another source later.",
    debug: {
      fromElements: fromElements.length,
      fromBody: fromBody.length,
    },
    augments,
    byId,
    byName,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Saved ${OUT_PATH}`);
  console.log(`Augments: ${payload.augmentCount}`);
  console.log(`Images found: ${payload.imageCount}`);
  console.log(`Parsed from elements: ${fromElements.length}`);
  console.log(`Parsed from body: ${fromBody.length}`);

  if (payload.augmentCount === 0) {
    throw new Error("No augments parsed. aramgg page structure may have changed.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
