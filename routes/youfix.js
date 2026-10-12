
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const guideFile = path.join(
  __dirname,
  "..",
  "data",
  "youfix-guides.json"
);
const phoneModelsFile = path.join(
  __dirname,
  "..",
  "data",
  "phone-models.json"
);

function readGuides() {
  const raw = fs.readFileSync(guideFile, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed.guides)) {
    throw new Error("Invalid YouFix guide data");
  }

  return parsed.guides;
}

router.get("/guides", (req, res) => {
  try {
    const guides = readGuides();
    const { deviceType, q } = req.query;

    let result = guides;

    if (deviceType) {
      result = result.filter(
        (guide) => guide.deviceType === deviceType
      );
    }

    if (q) {
      const query = String(q).toLowerCase();

      result = result.filter((guide) =>
        `${guide.title} ${guide.issue} ${guide.deviceLabel}`
          .toLowerCase()
          .includes(query)
      );
    }

    res.json({
      success: true,
      count: result.length,
      guides: result,
    });
  } catch (error) {
    console.error("YouFix guide read error:", error.message);

    res.status(500).json({
      success: false,
      message: "Could not load repair guides.",
    });
  }
});

router.get("/guides/:id", (req, res) => {
  try {
    const guide = readGuides().find(
      (item) => String(item.id) === req.params.id
    );

    if (!guide) {
      return res.status(404).json({
        success: false,
        message: "Guide not found.",
      });
    }

    res.json({ success: true, guide });
  } catch (error) {
    console.error("YouFix guide read error:", error.message);

    res.status(500).json({
      success: false,
      message: "Could not load repair guide.",
    });
  }
});
router.get("/models", (req, res) => {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(phoneModelsFile, "utf8")
    );

    const q = String(req.query.q || "").toLowerCase();
    const family = String(req.query.family || "").toLowerCase();

    const models = parsed.models.filter((model) => {
      const matchesQuery =
        !q ||
        `${model.brand} ${model.name} ${model.modelNumber}`
          .toLowerCase()
          .includes(q);

      const matchesFamily =
        !family || model.family.toLowerCase() === family;

      return matchesQuery && matchesFamily;
    });

    res.json({ success: true, count: models.length, models });
  } catch (error) {
    console.error("Phone model read error:", error.message);
    res.status(500).json({
      success: false,
      message: "Could not load phone models."
    });
  }
});

export default router;
