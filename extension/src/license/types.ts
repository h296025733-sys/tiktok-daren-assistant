export type LicenseStatusCode =
  | "disabled"
  | "unbound"
  | "active"
  | "revoked"
  | "unreachable";

export interface LicenseStatus {
  ok: boolean;
  authorized: boolean;
  status: LicenseStatusCode;
  message: string;
  key_id?: number;
  bound_at?: string;
}

export interface GetLicenseStatusRequest {
  type: "GET_LICENSE_STATUS";
  force?: boolean;
}

export interface ActivateLicenseRequest {
  type: "ACTIVATE_LICENSE";
  activation_key: string;
}

export type LicenseRequest = GetLicenseStatusRequest | ActivateLicenseRequest;

export function isLicenseRequest(value: unknown): value is LicenseRequest {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "GET_LICENSE_STATUS" || type === "ACTIVATE_LICENSE";
}

