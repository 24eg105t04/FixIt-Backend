import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import express from "express";

const tempDirectory = mkdtempSync(path.join(os.tmpdir(), "fixit-marketplace-bids-"));
process.env.FIXIT_DB_PATH = path.join(tempDirectory, "marketplace.sqlite");

const [{ default: authRoutes }, { default: marketplaceRoutes }, { db }] = await Promise.all([
  import("../routes/auth.js"),
  import("../routes/marketplace.js"),
  import("../db.js"),
]);

const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);
app.use("/api/marketplace", marketplaceRoutes);
app.use((error, req, res, next) => {
  res.status(error.status || 500).json({ error: error.message });
});

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function request(route, { method = "GET", token, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

async function register(role, suffix) {
  return request("/api/auth/register", {
    method: "POST",
    body: {
      name: `${role} ${suffix}`,
      email: `${role}-${suffix}@example.test`,
      password: `Test-${randomUUID()}-Aa1`,
      role,
    },
  });
}

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

test("seller bid is visible, editable by its owner, and locked after acceptance", async () => {
  const suffix = randomUUID();
  const customer = await register("customer", suffix);
  const otherCustomer = await register("customer", `${suffix}-other`);
  const seller = await register("seller", suffix);
  const otherSeller = await register("seller", `${suffix}-other`);
  assert.equal(customer.status, 201);
  assert.equal(otherCustomer.status, 201);
  assert.equal(seller.status, 201);
  assert.equal(otherSeller.status, 201);

  const profile = await request("/api/marketplace/shops/me", {
    method: "PUT",
    token: seller.body.token,
    body: { shopName: "Test Repair Shop", ownerName: "Test Seller", address: "1 Test Street", experienceYears: 2 },
  });
  assert.equal(profile.status, 200);

  const createdRequest = await request("/api/marketplace/requests", {
    method: "POST",
    token: customer.body.token,
    body: { deviceCategory: "Phone", brand: "Test", model: "One", issue: "Broken screen", description: "Test issue", location: "Test City" },
  });
  assert.equal(createdRequest.status, 201);
  const requestId = createdRequest.body.request.id;

  const openRequests = await request("/api/marketplace/requests/open", { token: seller.body.token });
  assert(openRequests.body.requests.some((item) => item.id === requestId));

  const initialBid = { price: 3200, estimatedHours: 5, partsRequired: ["Display"], warranty: "90 days", notes: "Genuine replacement" };
  const submitted = await request(`/api/marketplace/requests/${requestId}/bids`, { method: "POST", token: seller.body.token, body: initialBid });
  assert.equal(submitted.status, 201);

  const duplicate = await request(`/api/marketplace/requests/${requestId}/bids`, { method: "POST", token: seller.body.token, body: initialBid });
  assert.equal(duplicate.status, 409);

  const sellerBids = await request("/api/marketplace/bids/mine", { token: seller.body.token });
  assert.equal(sellerBids.body.bids[0].requestId, requestId);

  const deniedEdit = await request(`/api/marketplace/bids/${submitted.body.bid.id}`, {
    method: "PUT", token: otherSeller.body.token, body: { ...initialBid, price: 3300 },
  });
  assert.equal(deniedEdit.status, 403);
  const invalidEdit = await request(`/api/marketplace/bids/${submitted.body.bid.id}`, {
    method: "PUT", token: seller.body.token, body: { ...initialBid, price: -10 },
  });
  assert.equal(invalidEdit.status, 400);

  const editedBid = await request(`/api/marketplace/bids/${submitted.body.bid.id}`, {
    method: "PUT",
    token: seller.body.token,
    body: { ...initialBid, price: 3500, estimatedHours: 3, partsRequired: ["Panel", "Adhesive"], warranty: "180 days", notes: "Updated offer" },
  });
  assert.equal(editedBid.status, 200);
  assert.equal(editedBid.body.bid.price, 3500);

  const customerBids = await request(`/api/marketplace/requests/${requestId}/bids`, { token: customer.body.token });
  assert.equal(customerBids.status, 200);
  assert.equal(customerBids.body.bids.length, 1);
  assert.equal(customerBids.body.bids[0].price, 3500);
  assert.equal(customerBids.body.bids[0].shop.shopName, "Test Repair Shop");

  const privateBids = await request(`/api/marketplace/requests/${requestId}/bids`, { token: otherCustomer.body.token });
  assert.equal(privateBids.status, 404);

  const accepted = await request(`/api/marketplace/bids/${submitted.body.bid.id}/accept`, { method: "POST", token: customer.body.token });
  assert.equal(accepted.status, 201);
  const lockedEdit = await request(`/api/marketplace/bids/${submitted.body.bid.id}`, {
    method: "PUT", token: seller.body.token, body: { ...initialBid, price: 3600 },
  });
  assert.equal(lockedEdit.status, 409);
});
