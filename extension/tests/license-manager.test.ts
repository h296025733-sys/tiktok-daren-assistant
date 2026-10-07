// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("一次性设备授权", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("__TDA_LICENSE_ENFORCED__", true);
    vi.stubGlobal("__TDA_LICENSE_API_BASE__", "https://auth.example.test");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("首次激活生成设备凭据，后续校验复用同一凭据", async () => {
    const stored: Record<string, unknown> = {};
    const setAccessLevel = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      runtime: {
        id: "kpdocbejchofflefehdlphffcbdmphij",
        getManifest: () => ({ version: "0.1.28" }),
      },
      storage: {
        local: {
          setAccessLevel,
          get: async (key: string) => ({ [key]: stored[key] }),
          set: async (values: Record<string, unknown>) => Object.assign(stored, values),
        },
      },
    });
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        ok: true,
        authorized: true,
        status: "active",
        message: "设备授权有效",
        key_id: 1,
      }), { status: 200 });
    }));

    const { LicenseManager } = await import("../src/background/licenseManager");
    const manager = new LicenseManager();
    await manager.initialize();
    const activated = await manager.activate({
      type: "ACTIVATE_LICENSE",
      activation_key: "TDA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AA",
    });
    const validated = await manager.getStatus({ type: "GET_LICENSE_STATUS", force: true });

    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
    expect(activated.authorized).toBe(true);
    expect(validated.authorized).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.device_id).toBe(requests[1]?.device_id);
    expect(requests[0]?.device_secret).toBe(requests[1]?.device_secret);
    expect(requests[0]?.activation_key).toBe("TDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("主控不可达时不把设备误判成已授权", async () => {
    vi.stubGlobal("chrome", {
      runtime: {
        id: "kpdocbejchofflefehdlphffcbdmphij",
        getManifest: () => ({ version: "0.1.28" }),
      },
      storage: {
        local: {
          setAccessLevel: async () => undefined,
          get: async (key: string) => ({
            [key]: {
              device_id: "a".repeat(32),
              device_secret: "A".repeat(43),
            },
          }),
          set: async () => undefined,
        },
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("offline");
    }));
    const { LicenseManager } = await import("../src/background/licenseManager");
    const result = await new LicenseManager().getStatus({ type: "GET_LICENSE_STATUS", force: true });
    expect(result.authorized).toBe(false);
    expect(result.status).toBe("unreachable");
  });
});

