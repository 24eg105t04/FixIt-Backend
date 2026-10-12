import { Router } from "express";
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { db, transaction } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
const scrypt = promisify(scryptCallback);
const validRoles = new Set(["customer", "seller"]);
const safeUser = ({ id, email, name, role }) => ({ id, email, name, role });

async function makePasswordHash(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [algorithm, saltHex, expectedHex] = String(stored).split(":");
  if (algorithm !== "scrypt" || !saltHex || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createSession(userId) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))")
    .run(tokenHash, userId);
  return token;
}

router.post("/register", async (req, res, next) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const role = req.body?.role;
    if (name.length < 2 || name.length > 100) return res.status(400).json({ error: "Enter a name between 2 and 100 characters." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid email address." });
    if (password.length < 8 || password.length > 256) return res.status(400).json({ error: "Password must be between 8 and 256 characters." });
    if (!validRoles.has(role)) return res.status(400).json({ error: "Choose customer or seller account type." });

    const id = randomUUID();
    const passwordHash = await makePasswordHash(password);
    const token = transaction(() => {
      db.prepare("INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)")
        .run(id, email, name, passwordHash, role);
      if (role === "seller") {
        db.prepare("INSERT INTO shop_profiles (seller_id, owner_name) VALUES (?, ?)").run(id, name);
      }
      return createSession(id);
    });
    const user = db.prepare("SELECT id, email, name, role FROM users WHERE id = ?").get(id);
    res.status(201).json({ user: safeUser(user), token });
  } catch (error) {
    if (String(error.code).includes("SQLITE_CONSTRAINT_UNIQUE")) return res.status(409).json({ error: "An account with this email already exists." });
    next(error);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const account = db.prepare("SELECT id, email, name, role, password_hash FROM users WHERE email = ? COLLATE NOCASE").get(email);
    if (!account || !(await verifyPassword(password, account.password_hash))) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }
    const token = createSession(account.id);
    res.json({ user: safeUser(account), token });
  } catch (error) {
    next(error);
  }
});

router.get("/me", requireAuth, (req, res) => res.json({ user: safeUser(req.user) }));

router.post("/logout", requireAuth, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(req.sessionTokenHash);
  res.json({ success: true });
});

export default router;
