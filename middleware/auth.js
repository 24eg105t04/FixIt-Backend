import { createHash } from "node:crypto";
import { db } from "../db.js";

export function requireAuth(req, res, next) {
  const authorization = req.get("authorization") || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
  if (!token || token.length > 256) {
    return res.status(401).json({ error: "Authentication required." });
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const user = db.prepare(`
    SELECT users.id, users.email, users.name, users.role
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > datetime('now')
  `).get(tokenHash);
  if (!user) return res.status(401).json({ error: "Session expired. Please sign in again." });
  req.user = user;
  req.sessionTokenHash = tokenHash;
  next();
}

export function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) {
      return res.status(403).json({ error: "This action is not permitted for your account role." });
    }
    next();
  };
}
