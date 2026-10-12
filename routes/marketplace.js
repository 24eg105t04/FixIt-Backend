import { Router } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, transaction } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
const directory = path.dirname(fileURLToPath(import.meta.url));
const uploadDirectory = path.join(directory, "..", "uploads");
const categories = new Set(["Phone", "Laptop", "Tablet", "Headphones", "Other", "Other gadgets"]);
const lifecycle = new Set(["ACCEPTED", "IN_PROGRESS", "WAITING_FOR_PARTS", "READY_FOR_PICKUP", "COMPLETED", "CANCELLED"]);
const transitions = {
  ACCEPTED: new Set(["IN_PROGRESS", "CANCELLED"]),
  IN_PROGRESS: new Set(["WAITING_FOR_PARTS", "READY_FOR_PICKUP", "CANCELLED"]),
  WAITING_FOR_PARTS: new Set(["IN_PROGRESS", "READY_FOR_PICKUP", "CANCELLED"]),
  READY_FOR_PICKUP: new Set(["IN_PROGRESS", "COMPLETED", "CANCELLED"]),
  COMPLETED: new Set(),
  CANCELLED: new Set(),
};
const json = (value, fallback) => {
  try { return JSON.parse(value); } catch { return fallback; }
};
const safeProfile = (row) => row && ({
  sellerId: row.seller_id,
  shopName: row.shop_name,
  ownerName: row.owner_name,
  logoUrl: row.logo_url,
  coverImageUrl: row.cover_image_url,
  description: row.description,
  experienceYears: row.experience_years,
  phone: row.phone,
  publicEmail: row.public_email,
  address: row.address,
  latitude: row.latitude,
  longitude: row.longitude,
  openingHours: json(row.opening_hours, {}),
  categories: json(row.categories, []),
  services: json(row.services, []),
  pricingInfo: row.pricing_info,
  warrantyPolicy: row.warranty_policy,
  updatedAt: row.updated_at,
});

function text(value, max, field, required = false) {
  if (value == null && !required) return "";
  if (typeof value !== "string") throw Object.assign(new Error(`${field} must be text.`), { status: 400 });
  const trimmed = value.trim();
  if (required && !trimmed) throw Object.assign(new Error(`${field} is required.`), { status: 400 });
  if (trimmed.length > max) throw Object.assign(new Error(`${field} must be ${max} characters or fewer.`), { status: 400 });
  return trimmed;
}

function optionalCoordinate(value, min, max, field) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw Object.assign(new Error(`${field} is invalid.`), { status: 400 });
  }
  return number;
}

function stringList(value, field, maxItems = 30, maxLength = 160) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw Object.assign(new Error(`${field} must be a list with at most ${maxItems} items.`), { status: 400 });
  }
  return [...new Set(value.map((item) => text(item, maxLength, field, true)))];
}

async function storeImages(values) {
  if (values == null) return [];
  if (!Array.isArray(values) || values.length > 3) throw Object.assign(new Error("Upload up to three photos."), { status: 400 });
  await mkdir(uploadDirectory, { recursive: true });
  const saved = [];
  for (const dataUrl of values) {
    if (typeof dataUrl !== "string") throw Object.assign(new Error("Invalid image upload."), { status: 400 });
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw Object.assign(new Error("Photos must be JPG, PNG, or WEBP images."), { status: 400 });
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw Object.assign(new Error("Each image must be smaller than 5 MB."), { status: 400 });
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[match[1]];
    const filename = `${randomUUID()}.${ext}`;
    await writeFile(path.join(uploadDirectory, filename), bytes, { flag: "wx" });
    saved.push(`/uploads/${filename}`);
  }
  return saved;
}

function parseProfile(body, current = {}) {
  const experienceYears = body.experienceYears == null ? (current.experience_years || 0) : Number(body.experienceYears);
  if (!Number.isInteger(experienceYears) || experienceYears < 0 || experienceYears > 80) throw Object.assign(new Error("Experience must be a whole number from 0 to 80."), { status: 400 });
  let openingHours = body.openingHours ?? json(current.opening_hours, {});
  if (!openingHours || typeof openingHours !== "object" || Array.isArray(openingHours) || JSON.stringify(openingHours).length > 6000) throw Object.assign(new Error("Opening hours are invalid."), { status: 400 });
  const categoriesList = stringList(body.categories ?? json(current.categories, []), "Categories");
  const servicesList = stringList(body.services ?? json(current.services, []), "Services");
  const email = text(body.publicEmail ?? current.public_email ?? "", 254, "Public email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error("Public email is invalid."), { status: 400 });
  const phone = text(body.phone ?? current.phone ?? "", 32, "Phone");
  if (phone && !/^\+?[0-9 ()-]{7,32}$/.test(phone)) throw Object.assign(new Error("Phone number is invalid."), { status: 400 });
  return {
    shopName: text(body.shopName ?? current.shop_name ?? "", 120, "Shop name", true),
    ownerName: text(body.ownerName ?? current.owner_name ?? "", 100, "Owner name", true),
    logoUrl: text(body.logoUrl ?? current.logo_url ?? "", 500, "Logo URL"),
    coverImageUrl: text(body.coverImageUrl ?? current.cover_image_url ?? "", 500, "Cover image URL"),
    description: text(body.description ?? current.description ?? "", 2000, "Description"),
    experienceYears,
    phone,
    publicEmail: email,
    address: text(body.address ?? current.address ?? "", 500, "Address", true),
    latitude: optionalCoordinate(body.latitude ?? current.latitude, -90, 90, "Latitude"),
    longitude: optionalCoordinate(body.longitude ?? current.longitude, -180, 180, "Longitude"),
    openingHours: JSON.stringify(openingHours),
    categories: JSON.stringify(categoriesList),
    services: JSON.stringify(servicesList),
    pricingInfo: text(body.pricingInfo ?? current.pricing_info ?? "", 1200, "Pricing information"),
    warrantyPolicy: text(body.warrantyPolicy ?? current.warranty_policy ?? "", 1200, "Warranty policy"),
  };
}

function requestDto(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    deviceCategory: row.device_category,
    brand: row.brand,
    model: row.model,
    issue: row.issue,
    description: row.description,
    photos: json(row.photos, []),
    location: row.location_label,
    latitude: row.latitude,
    longitude: row.longitude,
    status: row.status,
    createdAt: row.created_at,
    bids: row.bid_count == null ? undefined : Number(row.bid_count),
  };
}

function parseBidInput(body = {}) {
  const price = Number(body.price);
  const estimatedHours = Number(body.estimatedHours);
  if (!Number.isFinite(price) || price <= 0 || price > 10000000) {
    throw Object.assign(new Error("Enter a valid repair price."), { status: 400 });
  }
  if (!Number.isFinite(estimatedHours) || estimatedHours <= 0 || estimatedHours > 8760) {
    throw Object.assign(new Error("Enter a valid completion estimate in hours."), { status: 400 });
  }
  return {
    price,
    estimatedHours,
    partsRequired: stringList(body.partsRequired ?? [], "Parts required", 30, 120),
    warranty: text(body.warranty ?? "", 500, "Warranty"),
    notes: text(body.notes ?? "", 2000, "Repair notes"),
  };
}

function bidDto(row) {
  return {
    id: row.id,
    requestId: row.request_id,
    sellerId: row.seller_id,
    price: Number(row.price),
    estimatedHours: Number(row.estimated_hours),
    partsRequired: json(row.parts_required, []),
    warranty: row.warranty,
    notes: row.notes,
    status: row.status,
    createdAt: row.created_at,
  };
}

const shopForSeller = db.prepare("SELECT * FROM shop_profiles WHERE seller_id = ?");
const publicShopSelect = `SELECT shop_profiles.*, users.name AS account_name
  FROM shop_profiles JOIN users ON users.id = shop_profiles.seller_id`;

router.get("/shops", (req, res) => {
  const rows = db.prepare(`${publicShopSelect} WHERE shop_profiles.shop_name <> '' ORDER BY shop_profiles.updated_at DESC`).all();
  res.json({ shops: rows.map(safeProfile) });
});

router.get("/shops/me", requireAuth, requireRole("seller"), (req, res) => {
  res.json({ profile: safeProfile(shopForSeller.get(req.user.id)) });
});

router.put("/shops/me", requireAuth, requireRole("seller"), (req, res, next) => {
  try {
    const current = shopForSeller.get(req.user.id);
    const profile = parseProfile(req.body || {}, current);
    const statement = db.prepare(`UPDATE shop_profiles SET
      shop_name=?, owner_name=?, logo_url=?, cover_image_url=?, description=?, experience_years=?,
      phone=?, public_email=?, address=?, latitude=?, longitude=?, opening_hours=?, categories=?,
      services=?, pricing_info=?, warranty_policy=?, updated_at=CURRENT_TIMESTAMP WHERE seller_id=?`);
    statement.run(profile.shopName, profile.ownerName, profile.logoUrl, profile.coverImageUrl, profile.description,
      profile.experienceYears, profile.phone, profile.publicEmail, profile.address, profile.latitude,
      profile.longitude, profile.openingHours, profile.categories, profile.services, profile.pricingInfo,
      profile.warrantyPolicy, req.user.id);
    res.json({ profile: safeProfile(shopForSeller.get(req.user.id)) });
  } catch (error) { next(error); }
});

router.post("/shops/me/images", requireAuth, requireRole("seller"), async (req, res, next) => {
  try {
    const field = req.body?.field;
    if (field !== "logoUrl" && field !== "coverImageUrl") return res.status(400).json({ error: "Choose a logo or cover image." });
    const [imageUrl] = await storeImages([req.body?.dataUrl]);
    const column = field === "logoUrl" ? "logo_url" : "cover_image_url";
    db.prepare(`UPDATE shop_profiles SET ${column}=?, updated_at=CURRENT_TIMESTAMP WHERE seller_id=?`).run(imageUrl, req.user.id);
    res.status(201).json({ imageUrl: `${req.protocol}://${req.get("host")}${imageUrl}` });
  } catch (error) { next(error); }
});

router.get("/shops/:sellerId", (req, res) => {
  const row = db.prepare(`${publicShopSelect} WHERE shop_profiles.seller_id = ? AND shop_profiles.shop_name <> ''`).get(req.params.sellerId);
  if (!row) return res.status(404).json({ error: "Repair shop not found." });
  res.json({ profile: safeProfile(row) });
});

router.get("/requests/open", requireAuth, requireRole("seller"), (req, res) => {
  const rows = db.prepare(`SELECT repair_requests.*, COUNT(bids.id) AS bid_count
    FROM repair_requests LEFT JOIN bids ON bids.request_id = repair_requests.id
    WHERE repair_requests.status = 'OPEN' GROUP BY repair_requests.id ORDER BY repair_requests.created_at DESC`).all();
  res.json({ requests: rows.map(requestDto) });
});

router.get("/requests/mine", requireAuth, requireRole("customer"), (req, res) => {
  const rows = db.prepare(`SELECT repair_requests.*, COUNT(bids.id) AS bid_count
    FROM repair_requests LEFT JOIN bids ON bids.request_id = repair_requests.id
    WHERE repair_requests.customer_id = ? GROUP BY repair_requests.id ORDER BY repair_requests.created_at DESC`).all(req.user.id);
  res.json({ requests: rows.map(requestDto) });
});

router.post("/requests", requireAuth, requireRole("customer"), async (req, res, next) => {
  try {
    const body = req.body || {};
    const category = text(body.deviceCategory, 40, "Device category", true);
    if (!categories.has(category)) return res.status(400).json({ error: "Choose a supported device category." });
    const issue = text(body.issue, 180, "Issue", true);
    const description = text(body.description || "", 4000, "Description");
    const location = text(body.location, 500, "Location", true);
    const latitude = optionalCoordinate(body.latitude, -90, 90, "Latitude");
    const longitude = optionalCoordinate(body.longitude, -180, 180, "Longitude");
    const photos = await storeImages(body.photos);
    const id = randomUUID();
    db.prepare(`INSERT INTO repair_requests
      (id, customer_id, device_category, brand, model, issue, description, photos, location_label, latitude, longitude)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.user.id, category, text(body.brand || "", 100, "Brand"), text(body.model || "", 120, "Model"),
        issue, description, JSON.stringify(photos), location, latitude, longitude);
    const row = db.prepare("SELECT * FROM repair_requests WHERE id=?").get(id);
    res.status(201).json({ request: requestDto(row) });
  } catch (error) { next(error); }
});

router.get("/requests/:requestId/bids", requireAuth, requireRole("customer"), (req, res) => {
  const request = db.prepare("SELECT id FROM repair_requests WHERE id=? AND customer_id=?").get(req.params.requestId, req.user.id);
  if (!request) return res.status(404).json({ error: "Repair request not found." });
  const rows = db.prepare(`SELECT bids.*, shop_profiles.shop_name, shop_profiles.owner_name,
      shop_profiles.logo_url, shop_profiles.phone, shop_profiles.public_email, shop_profiles.address,
      shop_profiles.latitude, shop_profiles.longitude, shop_profiles.experience_years,
      shop_profiles.warranty_policy, shop_profiles.categories, shop_profiles.services
    FROM bids JOIN shop_profiles ON shop_profiles.seller_id=bids.seller_id
    WHERE bids.request_id=? ORDER BY bids.price ASC`).all(request.id);
  res.json({ bids: rows.map((row) => ({
    id: row.id, requestId: row.request_id, sellerId: row.seller_id, price: row.price,
    estimatedHours: row.estimated_hours, partsRequired: json(row.parts_required, []),
    warranty: row.warranty, notes: row.notes, status: row.status, createdAt: row.created_at,
    shop: { sellerId: row.seller_id, shopName: row.shop_name, ownerName: row.owner_name,
      logoUrl: row.logo_url, phone: row.phone, publicEmail: row.public_email, address: row.address,
      latitude: row.latitude, longitude: row.longitude, experienceYears: row.experience_years,
      warrantyPolicy: row.warranty_policy, categories: json(row.categories, []), services: json(row.services, []) },
  })) });
});

router.post("/requests/:requestId/bids", requireAuth, requireRole("seller"), (req, res, next) => {
  try {
    const bidInput = parseBidInput(req.body);
    const request = db.prepare("SELECT * FROM repair_requests WHERE id=? AND status='OPEN'").get(req.params.requestId);
    if (!request) return res.status(404).json({ error: "Open repair request not found." });
    const profile = shopForSeller.get(req.user.id);
    if (!profile?.shop_name) return res.status(409).json({ error: "Complete your public shop profile before placing bids." });
    const id = randomUUID();
    db.prepare("INSERT INTO bids (id, request_id, seller_id, price, estimated_hours, parts_required, warranty, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, request.id, req.user.id, bidInput.price, bidInput.estimatedHours, JSON.stringify(bidInput.partsRequired), bidInput.warranty, bidInput.notes);
    const bid = db.prepare("SELECT * FROM bids WHERE id=?").get(id);
    res.status(201).json({ bid: bidDto(bid) });
  } catch (error) {
    if (error.errcode === 2067 || error.message?.includes("UNIQUE constraint failed: bids.request_id, bids.seller_id")) {
      return res.status(409).json({ error: "You have already bid on this request." });
    }
    next(error);
  }
});

router.put("/bids/:bidId", requireAuth, requireRole("seller"), (req, res, next) => {
  try {
    const bid = transaction(() => {
      const current = db.prepare(`SELECT bids.*, repair_requests.status AS request_status
        FROM bids JOIN repair_requests ON repair_requests.id=bids.request_id
        WHERE bids.id=?`).get(req.params.bidId);
      if (!current) throw Object.assign(new Error("Bid not found."), { status: 404 });
      if (current.seller_id !== req.user.id) throw Object.assign(new Error("You may only edit your own bids."), { status: 403 });
      if (current.status !== "SUBMITTED" || current.request_status !== "OPEN") {
        throw Object.assign(new Error("This bid can no longer be edited."), { status: 409 });
      }

      const input = parseBidInput(req.body);
      db.prepare(`UPDATE bids SET price=?, estimated_hours=?, parts_required=?, warranty=?, notes=?
        WHERE id=? AND seller_id=? AND status='SUBMITTED'`)
        .run(input.price, input.estimatedHours, JSON.stringify(input.partsRequired), input.warranty, input.notes, current.id, req.user.id);
      return db.prepare("SELECT * FROM bids WHERE id=?").get(current.id);
    });
    res.json({ bid: bidDto(bid) });
  } catch (error) {
    next(error);
  }
});

router.get("/bids/mine", requireAuth, requireRole("seller"), (req, res) => {
  const bids = db.prepare(`SELECT bids.*, repair_requests.device_category, repair_requests.brand, repair_requests.model,
      repair_requests.issue, repair_requests.description, repair_requests.location_label, repair_requests.status AS request_status
    FROM bids JOIN repair_requests ON repair_requests.id=bids.request_id
    WHERE bids.seller_id=? ORDER BY bids.created_at DESC`).all(req.user.id);
  res.json({ bids: bids.map((bid) => ({
    ...bidDto(bid),
    deviceCategory: bid.device_category,
    brand: bid.brand,
    model: bid.model,
    issue: bid.issue,
    description: bid.description,
    location: bid.location_label,
    requestStatus: bid.request_status,
  })) });
});

router.post("/bids/:bidId/accept", requireAuth, requireRole("customer"), (req, res, next) => {
  try {
    const job = transaction(() => {
      const bid = db.prepare(`SELECT bids.*, repair_requests.customer_id, repair_requests.status AS request_status
        FROM bids JOIN repair_requests ON repair_requests.id=bids.request_id WHERE bids.id=?`).get(req.params.bidId);
      if (!bid || bid.customer_id !== req.user.id) throw Object.assign(new Error("Bid not found for your repair request."), { status: 404 });
      if (bid.request_status !== "OPEN" || bid.status !== "SUBMITTED") throw Object.assign(new Error("This repair request or bid is no longer available."), { status: 409 });
      const jobId = randomUUID();
      db.prepare("INSERT INTO jobs (id, request_id, bid_id, customer_id, seller_id, status) VALUES (?, ?, ?, ?, ?, 'ACCEPTED')")
        .run(jobId, bid.request_id, bid.id, req.user.id, bid.seller_id);
      db.prepare("UPDATE repair_requests SET status='ACCEPTED', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(bid.request_id);
      db.prepare("UPDATE bids SET status=CASE WHEN id=? THEN 'ACCEPTED' ELSE 'REJECTED' END WHERE request_id=?").run(bid.id, bid.request_id);
      db.prepare("INSERT INTO job_status_history (id, job_id, actor_id, to_status, note) VALUES (?, ?, ?, 'ACCEPTED', ?)")
        .run(randomUUID(), jobId, req.user.id, "Customer accepted the repair bid.");
      return db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
    });
    res.status(201).json({ job });
  } catch (error) { next(error); }
});

router.get("/jobs/mine", requireAuth, (req, res) => {
  const ownerColumn = req.user.role === "seller" ? "seller_id" : "customer_id";
  const jobs = db.prepare(`SELECT jobs.*, repair_requests.device_category, repair_requests.brand, repair_requests.model,
      repair_requests.issue, repair_requests.description, repair_requests.photos, repair_requests.location_label,
      bids.price, bids.estimated_hours, bids.parts_required, bids.warranty, bids.notes AS bid_notes,
      shop_profiles.shop_name, shop_profiles.owner_name, shop_profiles.logo_url, shop_profiles.phone,
      shop_profiles.public_email, shop_profiles.address, shop_profiles.latitude, shop_profiles.longitude
    FROM jobs JOIN repair_requests ON repair_requests.id=jobs.request_id
    JOIN bids ON bids.id=jobs.bid_id JOIN shop_profiles ON shop_profiles.seller_id=jobs.seller_id
    WHERE jobs.${ownerColumn}=? ORDER BY jobs.updated_at DESC`).all(req.user.id);
  const history = db.prepare("SELECT from_status AS fromStatus, to_status AS toStatus, note, created_at AS createdAt FROM job_status_history WHERE job_id=? ORDER BY created_at ASC");
  res.json({ jobs: jobs.map((job) => ({
    id: job.id, requestId: job.request_id, bidId: job.bid_id, customerId: job.customer_id,
    sellerId: job.seller_id, status: job.status, createdAt: job.created_at, updatedAt: job.updated_at,
    request: { deviceCategory: job.device_category, brand: job.brand, model: job.model, issue: job.issue,
      description: job.description, photos: json(job.photos, []), location: job.location_label },
    bid: { price: Number(job.price), estimatedHours: Number(job.estimated_hours), partsRequired: json(job.parts_required, []), warranty: job.warranty, notes: job.bid_notes },
    shop: { sellerId: job.seller_id, shopName: job.shop_name, ownerName: job.owner_name,
      logoUrl: job.logo_url, phone: job.phone, publicEmail: job.public_email, address: job.address,
      latitude: job.latitude, longitude: job.longitude },
    history: history.all(job.id),
  })) });
});

router.patch("/jobs/:jobId/status", requireAuth, requireRole("seller"), (req, res, next) => {
  try {
    const status = req.body?.status;
    const note = text(req.body?.note || "", 1000, "Progress note");
    if (!lifecycle.has(status)) return res.status(400).json({ error: "Choose a valid repair status." });
    const job = transaction(() => {
      const current = db.prepare("SELECT * FROM jobs WHERE id=? AND seller_id=?").get(req.params.jobId, req.user.id);
      if (!current) throw Object.assign(new Error("Active repair not found for your shop."), { status: 404 });
      if (!transitions[current.status]?.has(status)) throw Object.assign(new Error(`Cannot move a repair from ${current.status} to ${status}.`), { status: 409 });
      db.prepare("UPDATE jobs SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status, current.id);
      db.prepare("UPDATE repair_requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status, current.request_id);
      db.prepare("INSERT INTO job_status_history (id, job_id, actor_id, from_status, to_status, note) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), current.id, req.user.id, current.status, status, note);
      return db.prepare("SELECT * FROM jobs WHERE id=?").get(current.id);
    });
    res.json({ job });
  } catch (error) { next(error); }
});

export default router;
