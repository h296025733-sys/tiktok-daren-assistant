import { LICENSE_API_BASE, LICENSE_ENFORCED } from "../license/config";
import type {
  ActivateLicenseRequest,
  GetLicenseStatusRequest,
  LicenseStatus,
} from "../license/types";

const DEVICE_CREDENTIAL_KEY = "deviceLicenseCredentialV1";
const VALIDATION_CACHE_MS = 5 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 8_000;

interface DeviceCredential {
  device_id: string;
  device_secret: string;
}

interface ServerLicenseResponse {
  ok?: unknown;
  authorized?: unknown;
  status?: unknown;
  message?: unknown;
  key_id?: unknown;
  bound_at?: unknown;
  detail?: unknown;
}

export class LicenseManager {
  private cached: { status: LicenseStatus; checkedAt: number } | null = null;
  private validation: Promise<LicenseStatus> | null = null;

  async initialize(): Promise<void> {
    if (!LICENSE_ENFORCED) return;
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  }

  async getStatus(request: GetLicenseStatusRequest = { type: "GET_LICENSE_STATUS" }): Promise<LicenseStatus> {
    if (!LICENSE_ENFORCED) return disabledStatus();
    if (!request.force && this.cached && Date.now() - this.cached.checkedAt < VALIDATION_CACHE_MS) {
      return this.cached.status;
    }
    if (this.validation) return this.validation;
    this.validation = this.validateStoredCredential().finally(() => {
      this.validation = null;
    });
    return this.validation;
  }

  async activate(request: ActivateLicenseRequest): Promise<LicenseStatus> {
    if (!LICENSE_ENFORCED) return disabledStatus();
    const activationKey = normalizeActivationKey(request.activation_key);
    if (!/^TDA[A-Z0-9]{32}$/.test(activationKey)) {
      return status(false, "unbound", "激活码格式不正确，请检查后重试");
    }
    const credential = await this.getOrCreateCredential();
    const response = await this.post("/api/v1/license/activate", {
      activation_key: activationKey,
      ...credential,
      ...extensionIdentity(),
    });
    const parsed = parseServerResponse(response);
    this.cached = { status: parsed, checkedAt: Date.now() };
    return parsed;
  }

  private async validateStoredCredential(): Promise<LicenseStatus> {
    const credential = await this.readCredential();
    if (!credential) {
      const current = status(false, "unbound", "请输入主控发放的一次性设备激活码");
      this.cached = { status: current, checkedAt: Date.now() };
      return current;
    }
    try {
      const response = await this.post("/api/v1/license/validate", {
        ...credential,
        ...extensionIdentity(),
      });
      const parsed = parseServerResponse(response);
      this.cached = { status: parsed, checkedAt: Date.now() };
      return parsed;
    } catch (error) {
      const current = status(
        false,
        "unreachable",
        error instanceof Error && error.message
          ? `暂时无法连接主控电脑：${error.message}`
          : "暂时无法连接主控电脑",
      );
      this.cached = { status: current, checkedAt: Date.now() };
      return current;
    }
  }

  private async post(path: string, body: Record<string, unknown>): Promise<ServerLicenseResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${LICENSE_API_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      const payload = await readSafeJson(response);
      if (!response.ok) {
        const message = typeof payload.detail === "string" ? payload.detail : `主控返回 HTTP ${response.status}`;
        return { ok: false, authorized: false, status: "unbound", message };
      }
      return payload;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("连接超时");
      }
      throw new Error(error instanceof Error ? error.message : "网络连接失败");
    } finally {
      clearTimeout(timer);
    }
  }

  private async getOrCreateCredential(): Promise<DeviceCredential> {
    const existing = await this.readCredential();
    if (existing) return existing;
    const credential = {
      device_id: randomHex(16),
      device_secret: randomBase64Url(32),
    };
    await chrome.storage.local.set({ [DEVICE_CREDENTIAL_KEY]: credential });
    return credential;
  }

  private async readCredential(): Promise<DeviceCredential | null> {
    const stored = await chrome.storage.local.get(DEVICE_CREDENTIAL_KEY);
    const value = stored[DEVICE_CREDENTIAL_KEY];
    if (!value || typeof value !== "object") return null;
    const candidate = value as Partial<DeviceCredential>;
    return typeof candidate.device_id === "string" && /^[a-f0-9]{32}$/.test(candidate.device_id) &&
      typeof candidate.device_secret === "string" && /^[A-Za-z0-9_-]{43}$/.test(candidate.device_secret)
      ? { device_id: candidate.device_id, device_secret: candidate.device_secret }
      : null;
  }
}

function extensionIdentity(): { extension_id: string; extension_version: string } {
  return {
    extension_id: chrome.runtime.id,
    extension_version: chrome.runtime.getManifest().version,
  };
}

function normalizeActivationKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function parseServerResponse(value: ServerLicenseResponse): LicenseStatus {
  const authorized = value.authorized === true;
  const serverStatus = value.status;
  const code = authorized
    ? "active"
    : serverStatus === "revoked"
      ? "revoked"
      : "unbound";
  return {
    ok: value.ok === true,
    authorized,
    status: code,
    message: typeof value.message === "string" && value.message.trim()
      ? value.message.trim().slice(0, 200)
      : authorized
        ? "设备授权有效"
        : "设备尚未授权",
    ...(typeof value.key_id === "number" && Number.isInteger(value.key_id) ? { key_id: value.key_id } : {}),
    ...(typeof value.bound_at === "string" ? { bound_at: value.bound_at.slice(0, 40) } : {}),
  };
}

async function readSafeJson(response: Response): Promise<ServerLicenseResponse> {
  const text = await response.text();
  if (!text || text.length > 4_096) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function disabledStatus(): LicenseStatus {
  return { ok: true, authorized: true, status: "disabled", message: "当前构建未启用设备授权" };
}

function status(authorized: boolean, code: LicenseStatus["status"], message: string): LicenseStatus {
  return { ok: true, authorized, status: code, message };
}

function randomHex(byteLength: number): string {
  return [...crypto.getRandomValues(new Uint8Array(byteLength))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

