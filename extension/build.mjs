import { build as esbuild } from "esbuild";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build as viteBuild } from "vite";

const chromeOnly = process.env.TDA_CHROME_ONLY_BUILD === "1";
const speedDiagnostics = process.env.TDA_SPEED_DIAGNOSTICS === "1";
const licenseEnforced = process.env.TDA_LICENSE_ENFORCED === "1";
const licenseApiBase = (process.env.TDA_LICENSE_API_BASE || "http://localhost:8766").replace(/\/+$/, "");
const licenseUrl = new URL(licenseApiBase);
if (
  !((licenseUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(licenseUrl.hostname)) ||
    licenseUrl.protocol === "https:")
) {
  throw new Error("TDA_LICENSE_API_BASE must use HTTPS, except for local testing");
}
const compileTimeDefines = {
  __TDA_CHROME_ONLY__: JSON.stringify(chromeOnly),
  __TDA_SPEED_DIAGNOSTICS__: JSON.stringify(speedDiagnostics),
  __TDA_LICENSE_ENFORCED__: JSON.stringify(licenseEnforced),
  __TDA_LICENSE_API_BASE__: JSON.stringify(licenseApiBase),
};

await viteBuild();

await Promise.all([
  esbuild({
    entryPoints: ["src/background/index.ts"],
    bundle: true,
    outfile: "dist/background.js",
    format: "esm",
    platform: "browser",
    target: "chrome116",
    sourcemap: false,
    define: compileTimeDefines,
  }),
  esbuild({
    entryPoints: ["src/content/index.ts"],
    bundle: true,
    outfile: "dist/content.js",
    format: "iife",
    platform: "browser",
    target: "chrome116",
    sourcemap: false,
    define: compileTimeDefines,
  }),
  esbuild({
    entryPoints: ["src/content/pageBridge.ts"],
    bundle: true,
    outfile: "dist/page-bridge.js",
    format: "iife",
    platform: "browser",
    target: "chrome116",
    sourcemap: false,
    define: compileTimeDefines,
  }),
]);

const pnpmPackages = await readdir("node_modules/.pnpm");
const onnxPackage = pnpmPackages.find((name) => name.startsWith("onnxruntime-web@"));
if (!onnxPackage) throw new Error("onnxruntime-web runtime files are missing");
const onnxDist = join(
  "node_modules/.pnpm",
  onnxPackage,
  "node_modules/onnxruntime-web/dist",
);
const onnxOutput = "dist/assets/onnx";
await mkdir(onnxOutput, { recursive: true });
await Promise.all([
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
].map((name) => cp(join(onnxDist, name), join(onnxOutput, name))));

if (chromeOnly) {
  const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
  manifest.host_permissions = manifest.host_permissions.filter(
    (value) => !value.includes(":8765"),
  );
  manifest.content_security_policy.extension_pages =
    manifest.content_security_policy.extension_pages
      .replaceAll(" http://127.0.0.1:8765", "")
      .replaceAll(" http://localhost:8765", "");
  if (licenseEnforced) {
    const licensePermission = `${licenseUrl.origin}/*`;
    if (!manifest.host_permissions.includes(licensePermission)) {
      manifest.host_permissions.push(licensePermission);
    }
    const connectSource = ` ${licenseUrl.origin}`;
    if (!manifest.content_security_policy.extension_pages.includes(connectSource)) {
      manifest.content_security_policy.extension_pages += connectSource;
    }
  }
  await writeFile("dist/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile("dist/CHROME_ONLY_BUILD", "TDA_CHROME_ONLY_ACTIVE\n", "utf8");
} else {
  await cp("manifest.json", "dist/manifest.json");
}

if (speedDiagnostics) {
  await writeFile("dist/SPEED_DIAGNOSTICS_BUILD", "TDA_SPEED_DIAGNOSTICS_ACTIVE\n", "utf8");
}
