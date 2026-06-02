import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DETECTION_PATH = path.join("data", "aramgg-id-map-detection.json");
const CDRAGON_PATH = path.join("data", "cdragon-arena-augments.json");
const OUT_PATH = path.join("data", "aramgg-id-bridge.json");

const MIN_CONFIDENCE = process.env.MIN_CONFIDENCE || "medium";
const confidenceRank = { none: 0, low: 1, medium: 2, high: 3 };

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function pickCandidate(entry) {
  if (!entry) return null;

  const candidates = entry.candidates || [];
  if (!candidates.length) return null;

  const minRank = confidenceRank[MIN_CONFIDENCE] ?? confidenceRank.medium;
  const entryRank = confidenceRank[entry.confidence || "none"] ?? 0;

  if (entryRank < minRank) return null;

  return candidates[0];
}

async function main() {
  const detection = await readJson(DETECTION_PATH);
  const cdragon = await readJson(CDRAGON_PATH);

  const byAramggId = {};
  const skipped = {};

  for (const [aramggId, entry] of Object.entries(detection.likelyMap || {})) {
    const candidate = pickCandidate(entry);

    if (!candidate) {
      skipped[aramggId] = {
        reason: "No candidate above confidence threshold",
        confidence: entry?.confidence || "none",
      };
      continue;
    }

    const cdragonInfo = cdragon.byId?.[candidate.cdragonId] || null;

    byAramggId[aramggId] = {
      aramggId,
      confidence: entry.confidence,
      score: candidate.score,
      cdragonId: candidate.cdragonId,
      nameZh: cdragonInfo?.nameZh || candidate.nameZh || "",
      nameEn: cdragonInfo?.nameEn || candidate.nameEn || "",
      name: cdragonInfo?.name || candidate.nameZh || candidate.nameEn || "",
      apiName: cdragonInfo?.apiName || candidate.apiName || "",
      icon: cdragonInfo?.icon || candidate.icon || "",
      rarity: cdragonInfo?.rarity || "",
      hitKinds: candidate.hitKinds || [],
      evidenceUrl: candidate.evidenceUrl || "",
      evidenceType: candidate.evidenceType || "",
    };
  }

  const payload = {
    source: {
      detection: DETECTION_PATH,
      cdragon: CDRAGON_PATH,
    },
    builtAt: new Date().toISOString(),
    minConfidence: MIN_CONFIDENCE,
    mappedCount: Object.keys(byAramggId).length,
    skippedCount: Object.keys(skipped).length,
    byAramggId,
    skipped,
    note:
      "Bridge table from aramgg internal augment ids to CommunityDragon augment metadata. The webpage should look up byAramggId[augmentId] before falling back to raw #ID.",
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Saved ${OUT_PATH}`);
  console.log(`Mapped: ${payload.mappedCount}`);
  console.log(`Skipped: ${payload.skippedCount}`);

  if (payload.mappedCount === 0) {
    throw new Error("No mappings generated. Check data/aramgg-id-map-detection.json.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
