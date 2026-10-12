import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const databasePath = path.resolve(
  process.env.FIXIT_DB_PATH || path.join(directory, "data", "fixit.sqlite")
);

export const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('customer', 'seller')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS shop_profiles (
    seller_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    shop_name TEXT NOT NULL DEFAULT '',
    owner_name TEXT NOT NULL DEFAULT '',
    logo_url TEXT NOT NULL DEFAULT '',
    cover_image_url TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    experience_years INTEGER NOT NULL DEFAULT 0,
    phone TEXT NOT NULL DEFAULT '',
    public_email TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    latitude REAL,
    longitude REAL,
    opening_hours TEXT NOT NULL DEFAULT '{}',
    categories TEXT NOT NULL DEFAULT '[]',
    services TEXT NOT NULL DEFAULT '[]',
    pricing_info TEXT NOT NULL DEFAULT '',
    warranty_policy TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS repair_requests (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES users(id),
    device_category TEXT NOT NULL,
    brand TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    issue TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    photos TEXT NOT NULL DEFAULT '[]',
    location_label TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_FOR_PARTS', 'READY_FOR_PICKUP', 'COMPLETED', 'CANCELLED')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS requests_open_idx ON repair_requests(status, created_at);
  CREATE INDEX IF NOT EXISTS requests_customer_idx ON repair_requests(customer_id, created_at);
  CREATE TABLE IF NOT EXISTS bids (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES repair_requests(id) ON DELETE CASCADE,
    seller_id TEXT NOT NULL REFERENCES users(id),
    price REAL NOT NULL CHECK (price > 0),
    estimated_hours REAL NOT NULL CHECK (estimated_hours > 0),
    parts_required TEXT NOT NULL DEFAULT '[]',
    warranty TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(request_id, seller_id)
  );
  CREATE INDEX IF NOT EXISTS bids_request_idx ON bids(request_id, created_at);
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE REFERENCES repair_requests(id),
    bid_id TEXT NOT NULL UNIQUE REFERENCES bids(id),
    customer_id TEXT NOT NULL REFERENCES users(id),
    seller_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL CHECK (status IN ('ACCEPTED', 'IN_PROGRESS', 'WAITING_FOR_PARTS', 'READY_FOR_PICKUP', 'COMPLETED', 'CANCELLED')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS jobs_customer_idx ON jobs(customer_id, updated_at);
  CREATE INDEX IF NOT EXISTS jobs_seller_idx ON jobs(seller_id, updated_at);
  CREATE TABLE IF NOT EXISTS job_status_history (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES users(id),
    from_status TEXT,
    to_status TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS history_job_idx ON job_status_history(job_id, created_at);
`);

export function transaction(callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
