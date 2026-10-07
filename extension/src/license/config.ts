declare const __TDA_LICENSE_ENFORCED__: boolean;
declare const __TDA_LICENSE_API_BASE__: string;

export const LICENSE_ENFORCED =
  typeof __TDA_LICENSE_ENFORCED__ !== "undefined" && __TDA_LICENSE_ENFORCED__;

export const LICENSE_API_BASE =
  typeof __TDA_LICENSE_API_BASE__ === "string"
    ? __TDA_LICENSE_API_BASE__.replace(/\/+$/, "")
    : "http://localhost:8766";

export const LICENSE_API_ORIGIN = new URL(LICENSE_API_BASE).origin;

