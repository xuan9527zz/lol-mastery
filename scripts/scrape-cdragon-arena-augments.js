import * as cheerio from "cheerio";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const PATCH = process.env.CDRAGON_PATCH || "16.11";
const ICON_DIR_URL = `https://raw.communitydragon.org/${PATCH}/game/assets/ux/cherry/augments/icons/`;
const ARENA_URLS = [
  `https://raw.communitydragon.org/${PATCH}/cdragon/arena/zh_cn.json`,
  `https://raw.communitydragon.org/${PATCH}/cdragon/arena/en_us.json`,
  `https://raw.communitydragon.org/latest/cdragon/arena/zh_cn.json`,
  `https://raw.communitydragon.org/latest/cdragon/arena/en_us.json`,
];

const OUT_PATH = path.join("data", "cdragon-arena-augments.json");

function absoluteUrl(url) {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://raw.communitydragon.org${url}`;
  return url;
}

function normalizeKey(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/\.(png|jpg|jpeg|webp)$/i, "")
    .replace(/\.arena_\d{4}_s\d+_a\d+/i, "")
    .replace(/_(large|small)$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

function cleanIconPath(value = "") {
  if (!value) return "";
  let icon = String(value).replace(/^\/lol-game-data\/assets/i, "");
  icon = icon.replace(/^\/assets/i, "/game/assets");
  if (icon.startsWith("/game/")) {
    return `https://raw.communitydragon.org/${PATCH}${icon.toLowerCase()}`;
  }
  if (icon.startsWith("game/")) {
    return `https://raw.communitydragon.org/${PATCH}/${icon.toLowerCase()}`;
  }
  return absoluteUrl(icon).toLowerCase();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; personal-cdragon-arena-augments/1.0; +https://github.com/)",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status}: ${url}`);
  }

  return await response.text();
}

async function fetchJsonMaybe(url) {
  try {
    const text = await fetchText(url);
    return JSON.parse(text);
  } catch (error) {
    console.warn(`Skip ${url}: ${error.message}`);
    return null;
  }
}

async function parseIconDirectory() {
  console.log(`Fetching icon directory: ${ICON_DIR_URL}`);
  const html = await fetchText(ICON_DIR_URL);
  const $ = cheerio.load(html);
  const byKey = {};
  const files = [];

  $("a").each((_, el) => {
    const href = $(el).attr("href") || "";
    const name = $(el).text().trim() || href.split("/").pop();
    if (!name || !/\.(png|jpg|jpeg|webp)$/i.test(name)) return;

    const url = href.startsWith("http")
      ? href
      : `${ICON_DIR_URL}${encodeURIComponent(name).replace(/%2F/g, "/")}`;

    const key = normalizeKey(name);
    if (!key) return;

    const size = /_small/i.test(name) ? "small" : "large";
    const item = {
      fileName: name,
      key,
      size,
      url,
    };

    files.push(item);

    if (!byKey[key]) byKey[key] = {};
    byKey[key][size] = item;
    byKey[key].best = byKey[key].large || byKey[key].small || item;
  });

  return { files, byKey };
}

function flattenObjects(value, output = []) {
  if (!value || typeof value !== "object") return output;

  if (Array.isArray(value)) {
    for (const item of value) flattenObjects(item, output);
    return output;
  }

  output.push(value);

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") flattenObjects(child, output);
  }

  return output;
}

function getFirst(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
  }
  return "";
}

function extractAugmentsFromArenaJson(data, localeLabel, iconByKey) {
  const objects = flattenObjects(data);
  const augments = [];

  for (const obj of objects) {
    const id = getFirst(obj, ["id", "augmentId", "augmentID", "apiId", "itemId"]);
    const apiName = getFirst(obj, ["apiName", "api_name", "nameId", "nameID", "internalName"]);
    const name = getFirst(obj, ["name", "displayName", "localizedName", "title"]);
    const rarity = getFirst(obj, ["rarity", "tier", "augmentRarity"]);
    const iconRaw = getFirst(obj, [
      "icon",
      "iconPath",
      "iconSmall",
      "iconLarge",
      "image",
      "imagePath",
      "texture",
      "loadoutsIcon",
    ]);

    const hasAugmentSignal =
      id !== "" &&
      (apiName || name || iconRaw) &&
      Object.keys(obj).some((key) => /augment|api|icon|rarity|tier|name/i.test(key));

    if (!hasAugmentSignal) continue;

    const idString = String(id);
    const apiKey = normalizeKey(apiName);
    const nameKey = normalizeKey(name);
    const iconPath = cleanIconPath(iconRaw);

    const matchedIcon =
      (apiKey && iconByKey[apiKey]?.best?.url) ||
      (nameKey && iconByKey[nameKey]?.best?.url) ||
      iconPath ||
      "";

    augments.push({
      id: idString,
      apiName: String(apiName || ""),
      name: String(name || ""),
      rarity: String(rarity || ""),
      icon: matchedIcon,
      iconSource: matchedIcon
        ? iconPath && matchedIcon === iconPath
          ? "arena-json"
          : "icon-directory"
        : "",
      locale: localeLabel,
      rawIcon: String(iconRaw || ""),
    });
  }

  // Deduplicate by id + locale
  const map = new Map();
  for (const item of augments) {
    if (!item.id) continue;
    const old = map.get(item.id);
    if (!old) {
      map.set(item.id, item);
      continue;
    }

    map.set(item.id, {
      ...old,
      ...Object.fromEntries(Object.entries(item).filter(([, v]) => v !== "")),
      icon: old.icon || item.icon,
      name: old.name || item.name,
      apiName: old.apiName || item.apiName,
      rarity: old.rarity || item.rarity,
    });
  }

  return [...map.values()];
}

function mergeLocales(zhAugments, enAugments) {
  const byId = {};

  for (const item of enAugments) {
    byId[item.id] = {
      id: item.id,
      name: item.name,
      nameEn: item.name,
      nameZh: "",
      apiName: item.apiName,
      rarity: item.rarity,
      icon: item.icon,
      iconSource: item.iconSource,
    };
  }

  for (const item of zhAugments) {
    const old = byId[item.id] || {};
    byId[item.id] = {
      id: item.id,
      name: item.name || old.name || old.nameEn || "",
      nameZh: item.name || old.nameZh || "",
      nameEn: old.nameEn || "",
      apiName: old.apiName || item.apiName || "",
      rarity: item.rarity || old.rarity || "",
      icon: item.icon || old.icon || "",
      iconSource: item.iconSource || old.iconSource || "",
    };
  }

  return byId;
}

async function main() {
  const icons = await parseIconDirectory();

  let zhData = null;
  let enData = null;
  let zhSource = "";
  let enSource = "";

  for (const url of ARENA_URLS) {
    const data = await fetchJsonMaybe(url);
    if (!data) continue;

    if (url.includes("/zh_cn.json") && !zhData) {
      zhData = data;
      zhSource = url;
    }

    if (url.includes("/en_us.json") && !enData) {
      enData = data;
      enSource = url;
    }
  }

  const zhAugments = zhData ? extractAugmentsFromArenaJson(zhData, "zh_cn", icons.byKey) : [];
  const enAugments = enData ? extractAugmentsFromArenaJson(enData, "en_us", icons.byKey) : [];
  const byId = mergeLocales(zhAugments, enAugments);

  const augments = Object.values(byId).sort((a, b) => Number(a.id) - Number(b.id));
  const byApiName = {};
  const byName = {};

  for (const item of augments) {
    if (item.apiName) byApiName[item.apiName] = item;
    if (item.name) byName[item.name] = item;
    if (item.nameZh) byName[item.nameZh] = item;
    if (item.nameEn) byName[item.nameEn] = item;
  }

  const payload = {
    source: {
      iconDirectory: ICON_DIR_URL,
      zhArenaJson: zhSource,
      enArenaJson: enSource,
    },
    scrapedAt: new Date().toISOString(),
    iconFileCount: icons.files.length,
    augmentCount: augments.length,
    augmentIconCount: augments.filter((item) => item.icon).length,
    note:
      "CommunityDragon arena augment metadata and icon directory snapshot. Use byId[augmentId] to map numeric augment ids to Chinese names and icons.",
    augments,
    byId,
    byApiName,
    byName,
    iconFiles: icons.files,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Saved ${OUT_PATH}`);
  console.log(`Icon files: ${payload.iconFileCount}`);
  console.log(`Augments: ${payload.augmentCount}`);
  console.log(`Augments with icons: ${payload.augmentIconCount}`);

  if (payload.iconFileCount === 0) {
    throw new Error("No icon files parsed from CommunityDragon directory.");
  }

  if (payload.augmentCount === 0) {
    throw new Error("No augment metadata parsed from CDragon arena JSON.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
