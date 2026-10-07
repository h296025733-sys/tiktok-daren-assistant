const EXTENSION_ID = "kpdocbejchofflefehdlphffcbdmphij";
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const DEVICE_ID_PATTERN = /^[a-f0-9]{32}$/;
const DEVICE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const VERSION_PATTERN = /^[A-Za-z0-9._+-]{1,32}$/;
const KEY_PATTERN = /^TDA[A-Z0-9]{32}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_BODY_BYTES = 8_192;

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return preflight(request);
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "tda-device-license" }, 200, request);
  }
  if (url.pathname.startsWith("/api/v1/admin/")) {
    return handleAdmin(request, env, url.pathname);
  }
  const origin = request.headers.get("Origin");
  if (origin && origin !== EXTENSION_ORIGIN) {
    return json({ ok: false, detail: "来源不允许" }, 403, request);
  }
  if (request.method !== "POST") {
    return json({ ok: false, detail: "请求方式不允许" }, 405, request);
  }
  if (url.pathname === "/api/v1/license/activate") return activate(request, env);
  if (url.pathname === "/api/v1/license/validate") return validate(request, env);
  return json({ ok: false, detail: "接口不存在" }, 404, request);
}

async function activate(request, env) {
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const identity = parseIdentity(body.value);
  const activationKey = normalizeActivationKey(body.value.activation_key);
  if (!identity || !KEY_PATTERN.test(activationKey)) {
    return json({ ok: false, detail: "激活码或设备信息格式不正确" }, 422, request);
  }
  const now = new Date().toISOString();
  const keyHash = await sha256Hex(activationKey);
  const secretHash = await sha256Hex(identity.device_secret);
  let row = await env.LICENSE_DB.prepare(
    "SELECT * FROM activation_keys WHERE key_hash = ?",
  ).bind(keyHash).first();
  if (!row || row.state === "revoked") {
    return json({ ok: false, detail: "激活码无效或已被停用" }, 403, request);
  }
  if (row.state === "bound") {
    if (row.device_id !== identity.device_id || row.device_secret_hash !== secretHash) {
      return json({ ok: false, detail: "这个激活码已经绑定过其他电脑" }, 409, request);
    }
    await touchLicense(env, row.id, identity.extension_version, now);
    return activeResponse(row, request);
  }
  try {
    const result = await env.LICENSE_DB.prepare(`
      UPDATE activation_keys
      SET state = 'bound', device_id = ?, device_secret_hash = ?,
          extension_id = ?, extension_version = ?, bound_at = ?, last_seen_at = ?
      WHERE key_hash = ? AND state = 'available'
        AND NOT EXISTS (SELECT 1 FROM activation_keys WHERE device_id = ?)
    `).bind(
      identity.device_id,
      secretHash,
      identity.extension_id,
      identity.extension_version,
      now,
      now,
      keyHash,
      identity.device_id,
    ).run();
    if ((result?.meta?.changes ?? 0) === 1) {
      row = await env.LICENSE_DB.prepare(
        "SELECT * FROM activation_keys WHERE key_hash = ?",
      ).bind(keyHash).first();
      return activeResponse(row, request);
    }
  } catch {
    // 唯一索引会拦住同一台设备占用多个激活码，下面统一返回可读结果。
  }
  row = await env.LICENSE_DB.prepare(
    "SELECT * FROM activation_keys WHERE key_hash = ?",
  ).bind(keyHash).first();
  if (row?.state === "bound" && row.device_id === identity.device_id && row.device_secret_hash === secretHash) {
    return activeResponse(row, request);
  }
  return json({ ok: false, detail: "这个激活码或这台电脑已经绑定过" }, 409, request);
}

async function validate(request, env) {
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const identity = parseIdentity(body.value);
  if (!identity) {
    return json({ ok: false, detail: "设备信息格式不正确" }, 422, request);
  }
  const secretHash = await sha256Hex(identity.device_secret);
  const row = await env.LICENSE_DB.prepare(
    "SELECT * FROM activation_keys WHERE device_id = ?",
  ).bind(identity.device_id).first();
  if (
    !row || row.state !== "bound" || row.extension_id !== identity.extension_id ||
    row.device_secret_hash !== secretHash
  ) {
    return json({
      ok: true,
      authorized: false,
      status: "revoked",
      message: "这台电脑的授权无效或已被停用",
    }, 200, request);
  }
  await touchLicense(env, row.id, identity.extension_version, new Date().toISOString());
  return activeResponse(row, request, "设备授权有效");
}

async function handleAdmin(request, env, path) {
  if (!await isAdmin(request, env)) {
    return json({ ok: false, detail: "主控凭据无效" }, 401, request, false);
  }
  if (request.method === "GET" && path === "/api/v1/admin/licenses") {
    const result = await env.LICENSE_DB.prepare(`
      SELECT id, label, state, device_id, extension_version, created_at,
             bound_at, last_seen_at, revoked_at
      FROM activation_keys ORDER BY id
    `).all();
    return json({ ok: true, licenses: result.results ?? [] }, 200, request, false);
  }
  if (request.method === "POST" && path === "/api/v1/admin/keys/import") {
    const body = await readJson(request, false);
    if (!body.ok) return body.response;
    const keys = Array.isArray(body.value.keys) ? body.value.keys : [];
    if (keys.length < 1 || keys.length > 100) {
      return json({ ok: false, detail: "每次只能导入 1 到 100 个密钥" }, 422, request, false);
    }
    const now = new Date().toISOString();
    const statements = [];
    for (const item of keys) {
      const keyHash = typeof item?.key_hash === "string" ? item.key_hash.toLowerCase() : "";
      const label = typeof item?.label === "string" ? item.label.trim().slice(0, 80) : "";
      if (!HASH_PATTERN.test(keyHash) || !label) {
        return json({ ok: false, detail: "密钥摘要或备注格式不正确" }, 422, request, false);
      }
      statements.push(env.LICENSE_DB.prepare(`
        INSERT OR IGNORE INTO activation_keys (key_hash, label, state, created_at)
        VALUES (?, ?, 'available', ?)
      `).bind(keyHash, label, now));
    }
    await env.LICENSE_DB.batch(statements);
    return json({ ok: true, imported: keys.length }, 200, request, false);
  }
  const match = path.match(/^\/api\/v1\/admin\/licenses\/(\d+)\/(revoke|reset)$/);
  if (request.method === "POST" && match) {
    const keyId = Number(match[1]);
    const action = match[2];
    const now = new Date().toISOString();
    const sql = action === "revoke"
      ? "UPDATE activation_keys SET state = 'revoked', revoked_at = ? WHERE id = ?"
      : `UPDATE activation_keys SET state = 'available', device_id = NULL,
           device_secret_hash = NULL, extension_id = NULL, extension_version = NULL,
           bound_at = NULL, last_seen_at = NULL, revoked_at = NULL WHERE id = ?`;
    const statement = env.LICENSE_DB.prepare(sql);
    const result = action === "revoke"
      ? await statement.bind(now, keyId).run()
      : await statement.bind(keyId).run();
    if ((result?.meta?.changes ?? 0) !== 1) {
      return json({ ok: false, detail: "没有找到这个授权编号" }, 404, request, false);
    }
    return json({ ok: true, key_id: keyId, state: action === "revoke" ? "revoked" : "available" }, 200, request, false);
  }
  return json({ ok: false, detail: "主控接口不存在" }, 404, request, false);
}

function parseIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const device_id = typeof value.device_id === "string" ? value.device_id : "";
  const device_secret = typeof value.device_secret === "string" ? value.device_secret : "";
  const extension_id = typeof value.extension_id === "string" ? value.extension_id : "";
  const extension_version = typeof value.extension_version === "string" ? value.extension_version : "";
  if (
    !DEVICE_ID_PATTERN.test(device_id) || !DEVICE_SECRET_PATTERN.test(device_secret) ||
    !EXTENSION_ID_PATTERN.test(extension_id) || extension_id !== EXTENSION_ID ||
    !VERSION_PATTERN.test(extension_version)
  ) return null;
  return { device_id, device_secret, extension_id, extension_version };
}

async function readJson(request, cors = true) {
  const declared = Number(request.headers.get("Content-Length") || "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: json({ ok: false, detail: "请求内容过大" }, 413, request, cors) };
  }
  let text;
  try {
    text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("too large");
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return { ok: true, value };
  } catch {
    return { ok: false, response: json({ ok: false, detail: "请求内容不是有效 JSON" }, 400, request, cors) };
  }
}

async function touchLicense(env, id, version, now) {
  await env.LICENSE_DB.prepare(
    "UPDATE activation_keys SET last_seen_at = ?, extension_version = ? WHERE id = ?",
  ).bind(now, version, id).run();
}

function activeResponse(row, request, message = "这台电脑已经绑定成功") {
  return json({
    ok: true,
    authorized: true,
    status: "active",
    message,
    key_id: Number(row.id),
    bound_at: row.bound_at,
  }, 200, request);
}

async function isAdmin(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token || token.length > 256 || !env.ADMIN_TOKEN_SHA256) return false;
  return await sha256Hex(token) === String(env.ADMIN_TOKEN_SHA256).toLowerCase();
}

function preflight(request) {
  const origin = request.headers.get("Origin");
  if (origin !== EXTENSION_ORIGIN) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": EXTENSION_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    },
  });
}

function json(payload, status, request, cors = true) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (cors && request.headers.get("Origin") === EXTENSION_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = EXTENSION_ORIGIN;
    headers.Vary = "Origin";
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

export function normalizeActivationKey(value) {
  return typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
