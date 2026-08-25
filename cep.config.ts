import type { CEP_Config } from "vite-cep-plugin";
import { version } from "./package.json";

const config: CEP_Config = {
  version,
  id: "com.izunatext.nekomitai",
  displayName: "Nekomitai",
  symlink: "local",
  port: 3000,
  servePort: 5000,
  startingDebugPort: 8860,
  extensionManifestVersion: 6.0,
  // AE 25+ ships CEP 12 (Chromium 99 / Node 17); we rely on CEP 11+ cookie flags below
  requiredRuntimeVersion: 12.0,
  hosts: [{ name: "AEFT", version: "[25.0,99.9]" }],

  type: "Panel",
  iconDarkNormal: "./assets/light-icon.png",
  iconNormal: "./assets/dark-icon.png",
  iconDarkNormalRollOver: "./assets/light-icon.png",
  iconNormalRollOver: "./assets/dark-icon.png",
  // NOTE: deliberately NO --mixed-context — web content iframes must never see Node globals.
  // (cast: --disable-features=… is valid CEF but missing from the plugin's flag union)
  parameters: [
    "--v=0",
    "--enable-nodejs",
    "--enable-media-stream",
    "--persist-session-cookies",
    "--disable-site-isolation-trials",
    "--disable-features=SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure,NetworkService",
  ] as unknown as CEP_Config["parameters"],
  width: 500,
  height: 550,

  panels: [
    {
      mainPath: "./main/index.html",
      name: "main",
      panelDisplayName: "Nekomitai",
      autoVisible: true,
      width: 860,
      height: 620,
    },
  ],
  build: {
    jsxBin: "off",
    sourceMap: true,
  },
  zxp: {
    country: "JP",
    province: "Tokyo",
    org: "IzunaText", // no spaces — ZXPSignCmd -selfSignedCert splits on them
    // The cert is a THROWAWAY generated fresh by every `npm run zxp` run, so
    // this password guards nothing durable — but keep real values out of the
    // public repo anyway. Override with ZXP_CERT_PASSWORD when signing.
    // (typeof guard: this file is imported by the panel bundle via shared.ts,
    // where a bare `process` reference would throw.)
    password:
      (typeof process !== "undefined" && process.env.ZXP_CERT_PASSWORD) ||
      "nekomitai-selfsign",
    tsa: [
      "http://timestamp.digicert.com/", // Windows Only
      "http://timestamp.apple.com/ts01", // MacOS Only
    ],
    allowSkipTSA: false,
    sourceMap: false,
    jsxBin: "off",
  },
  // pure-JS adblock engine, require()d at runtime from dist/node_modules
  installModules: ["@ghostery/adblocker"],
  copyAssets: ["assets"], // relative to src/ → copied to dist/cep/src/assets (icon paths)
  copyZipAssets: [],
};
export default config;
