import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { handleRequest, normalizeActivationKey, sha256Hex } from "../src/index.js";

const EXTENSION_ORIGIN = "chrome-extension://kpdocbejchofflefehdlphffcbdmphij";
const EXTENSION_ID = "kpdocbejchofflefehdlphffcbdmphij";

test("normalizes a formatted activation key", () => {
  assert.equal(
    normalizeActivationKey("tda12-34567-89abc"),
    "TDA123456789ABC",
  );
});

test("hashes without exposing the source value", async () => {
  assert.equal(
    await sha256Hex("example"),
    "50d858e0985ecc7f60418aaf0cc5ab587f42c2570a884095a9e8ccacd0f6545c",
  );
});

test("health endpoint does not touch the database", async () => {
  const response = await handleRequest(new Request("https://license.example/health"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "tda-device-license" });
});

test("rejects a foreign browser origin before touching the database", async () => {
  const request = new Request("https://license.example/api/v1/license/validate", {
    method: "POST",
    headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: "{}",
  });
  const response = await handleRequest(request, {});
  assert.equal(response.status, 403);
});

test("rejects malformed device data before touching the database", async () => {
  const request = new Request("https://license.example/api/v1/license/activate", {
    method: "POST",
    headers: {
      Origin: "chrome-extension://kpdocbejchofflefehdlphffcbdmphij",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ activation_key: "TDA-WRONG" }),
  });
  const response = await handleRequest(request, {});
  assert.equal(response.status, 422);
});

test("one key binds once, can be revoked, reset, and rebound", async () => {
  const database = new MemoryD1();
  const adminToken = "master-token-for-local-worker-test-only";
  const env = {
    LICENSE_DB: database,
    ADMIN_TOKEN_SHA256: await sha256Hex(adminToken),
  };
  const activationKey = `TDA${"A".repeat(32)}`;
  await database.prepare(`
    INSERT INTO activation_keys (key_hash, label, state, created_at)
    VALUES (?, '员工设备01', 'available', '2026-08-14T00:00:00Z')
  `).bind(await sha256Hex(activationKey)).run();

  const deviceA = identity("a", "A");
  const deviceB = identity("b", "B");
  const first = await post(env, "/api/v1/license/activate", {
    activation_key: activationKey,
    ...deviceA,
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).authorized, true);

  const retry = await post(env, "/api/v1/license/activate", {
    activation_key: activationKey,
    ...deviceA,
  });
  assert.equal(retry.status, 200);

  const secondComputer = await post(env, "/api/v1/license/activate", {
    activation_key: activationKey,
    ...deviceB,
  });
  assert.equal(secondComputer.status, 409);

  const valid = await post(env, "/api/v1/license/validate", deviceA);
  assert.equal((await valid.json()).authorized, true);

  const revoked = await adminPost(env, adminToken, "/api/v1/admin/licenses/1/revoke");
  assert.equal(revoked.status, 200);
  const invalidAfterRevoke = await post(env, "/api/v1/license/validate", deviceA);
  assert.equal((await invalidAfterRevoke.json()).authorized, false);

  const reset = await adminPost(env, adminToken, "/api/v1/admin/licenses/1/reset");
  assert.equal(reset.status, 200);
  const rebound = await post(env, "/api/v1/license/activate", {
    activation_key: activationKey,
    ...deviceB,
  });
  assert.equal(rebound.status, 200);
  assert.equal((await rebound.json()).authorized, true);
});

function identity(deviceCharacter, secretCharacter) {
  return {
    device_id: deviceCharacter.repeat(32),
    device_secret: secretCharacter.repeat(43),
    extension_id: EXTENSION_ID,
    extension_version: "0.1.28",
  };
}

function post(env, path, body) {
  return handleRequest(new Request(`https://license.example${path}`, {
    method: "POST",
    headers: { Origin: EXTENSION_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), env);
}

function adminPost(env, token, path, body = {}) {
  return handleRequest(new Request(`https://license.example${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), env);
}

class MemoryD1 {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    this.database.exec(`
      CREATE TABLE activation_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'available',
        created_at TEXT NOT NULL,
        device_id TEXT UNIQUE,
        device_secret_hash TEXT,
        extension_id TEXT,
        extension_version TEXT,
        bound_at TEXT,
        last_seen_at TEXT,
        revoked_at TEXT
      )
    `);
  }

  prepare(sql) {
    return new MemoryD1Statement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class MemoryD1Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new MemoryD1Statement(this.database, this.sql, values);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values);
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}
