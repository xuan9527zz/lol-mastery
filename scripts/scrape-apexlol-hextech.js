import * as cheerio from "cheerio";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = "https://www.apexlol.info";
const LANG = "zh";
const INDEX_URL = `${BASE}/${LANG}/hextech`;
const OUT_PATH = path.join("data", "apexlol-hextech-dictionary.json");
const SLEEP_MS = Number(process.env.SLEEP_MS || 150);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeText(text = "") {
  return String(text).replace(/\s+/g, " ").trim();
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

function getSlugFromHref(href = "") {
  const match = href.match(/\/hextech\/([^/?#]+)/);
  return match?.[1] || "";
}

function parseIndex(html) {
  const $ = cheerio.load(html);
  const map = new Map();

  $("a[href*='/hextech/']").each((_, el) => {
    const href = absoluteUrl($(el).attr("href") || "");
    const slug = getSlugFromHref(href);
    if (!slug || slug === "hextech") return;

    const text = normalizeText($(el).text());
    let name = "";

    // Prefer short Chinese text from the anchor.
    const pieces = text
      .split(/(?=白银阶|黄金阶|棱彩阶)|\n/)
      .map(normalizeText)
      .filter(Boolean);

    for (const piece of pieces) {
      if (
        piece &&
        piece.length <= 30 &&
        !piece.includes("阶") &&
        !piece.includes("强化") &&
        !piece.includes("共")
      ) {
        name = piece;
        break;
      }
    }

    // Fallback: first non-empty text chunk.
    if (!name && text && text.length <= 40) name = text;

    let image = "";
    $(el)
      .find("img")
      .each((_, img) => {
        if (image) return;
        image = absoluteUrl($(img).attr("src") || $(img).attr("data-src") || "");
      });

    if (!map.has(slug)) {
      map.set(slug, {
        slug,
        url: href,
        nameZh: name,
        image,
      });
    }
  });

  return [...map.values()];
}

function parseDetail(html, item) {
  const $ = cheerio.load(html);
  const title = normalizeText($("title").first().text());
  const body = normalizeText($("body").text());

  let nameZh = item.nameZh || "";

  // Title likely: 双发快射 - ApexLoL ...
  if (!nameZh) {
    const titleMatch = title.match(/^(.+?)\s*[-|｜]/);
    if (titleMatch) nameZh = normalizeText(titleMatch[1]);
  }

  if (!nameZh) {
    const h1 = normalizeText($("h1").first().text());
    if (h1 && h1.length <= 30) nameZh = h1;
  }

  const tierMatch = body.match(/(白银阶|黄金阶|棱彩阶|白银|黄金|棱彩)/);
  const descriptionCandidates = [];

  $("p, div").each((_, el) => {
    const text = normalizeText($(el).text());
    if (!text || text.length < 8 || text.length > 200) return;
    if (text.includes("ApexLoL") || text.includes("隐私") || text.includes("版权")) return;
    if (text.includes(nameZh) && text.length < 40) return;
    if (/(获得|造成|你的|每当|施加|增加|减少|技能|攻击|暴击|治疗|护盾|伤害)/.test(text)) {
      descriptionCandidates.push(text);
    }
  });

  let image = item.image || "";
  $("img").each((_, img) => {
    if (image) return;
    const alt = normalizeText($(img).attr("alt") || "");
    const src = absoluteUrl($(img).attr("src") || $(img).attr("data-src") || "");
    if (!src) return;
    if (alt === nameZh || src.toLowerCase().includes(item.slug.toLowerCase()) || src.toLowerCase().includes("hextech")) {
      image = src;
    }
  });

  return {
    ...item,
    nameZh,
    tier: tierMatch?.[1] || "",
    description: descriptionCandidates[0] || "",
    image,
    title,
    normalizedName: normalizeName(nameZh),
  };
}

async function main() {
  console.log(`Fetching ApexLoL index: ${INDEX_URL}`);
  const html = await fetchText(INDEX_URL);
  const items = parseIndex(html);

  console.log(`Found ${items.length} hextech links.`);

  const hextech = [];
  const bySlug = {};
  const byName = {};
  const failures = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    try {
      console.log(`[${i + 1}/${items.length}] ${item.url}`);
      const detailHtml = await fetchText(item.url);
      const detail = parseDetail(detailHtml, item);

      hextech.push(detail);
      bySlug[detail.slug] = detail;
      if (detail.nameZh) byName[detail.nameZh] = detail;

      await sleep(SLEEP_MS);
    } catch (error) {
      failures.push({
        slug: item.slug,
        url: item.url,
        reason: error.message,
      });

      hextech.push(item);
      bySlug[item.slug] = item;
      if (item.nameZh) byName[item.nameZh] = item;
    }
  }

  const payload = {
    source: INDEX_URL,
    scrapedAt: new Date().toISOString(),
    count: hextech.length,
    imageCount: hextech.filter((item) => item.image).length,
    descriptionCount: hextech.filter((item) => item.description).length,
    hextech,
    bySlug,
    byName,
    byNormalizedName: Object.fromEntries(
      hextech
        .filter((item) => item.nameZh)
        .map((item) => [normalizeName(item.nameZh), item])
    ),
    failures,
    note:
      "ApexLoL hextech dictionary. Used as first-priority name/icon/slug mapping before CommunityDragon.",
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Saved ${OUT_PATH}`);
  console.log(`Count: ${payload.count}`);
  console.log(`Images: ${payload.imageCount}`);
  console.log(`Descriptions: ${payload.descriptionCount}`);
  console.log(`Failures: ${payload.failures.length}`);

  if (payload.count === 0) {
    throw new Error("No ApexLoL hextech entries parsed.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
