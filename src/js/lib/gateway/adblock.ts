/**
 * Adblock + anti-tracker engine (opt-in, off by default).
 *
 * Engine: @ghostery/adblocker (MPL-2.0), pure JS — no native ABI concerns in
 * CEP's Node. Lists: EasyList + EasyPrivacy only (CC BY-SA 3.0, attributed in
 * THIRD-PARTY-NOTICES). We deliberately do NOT use the prebuilt Ghostery engine
 * (it bundles Peter Lowe's non-commercial list). See the blueprint's licensing
 * section.
 *
 * Used by the Web Mode proxy: match() gates network requests, and
 * getCosmeticsFilters() supplies element-hiding CSS injected into pages.
 */
import { https, fs, path, os } from "../cep/node";

// loaded lazily so the adblocker package isn't required unless enabled
let FiltersEngine: any = null;
let RequestCls: any = null;

let engine: any = null;
let ready: Promise<void> | null = null;

export type AdblockState = {
  adblock: boolean;
  antitrack: boolean;
  blocked: number;
  listVersion: string | null;
  ready: boolean;
  loading: boolean;
  error: string | null;
};

const state: AdblockState = {
  adblock: false,
  antitrack: false,
  blocked: 0,
  listVersion: null,
  ready: false,
  loading: false,
  error: null,
};

const LISTS = [
  "https://easylist.to/easylist/easylist.txt",
  "https://easylist.to/easylist/easyprivacy.txt",
];

const dataDir = (): string => {
  const base =
    process.env.APPDATA ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : path.join(os.homedir(), ".config"));
  const dir = path.join(base, "Nekomitai");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const cachePath = () => path.join(dataDir(), "adblock-engine.bin");
const stampPath = () => path.join(dataDir(), "adblock-lists.json");

const getText = (url: string, redirects = 0): Promise<string> =>
  new Promise((resolve, reject) => {
    https
      .get(
        url,
        { headers: { "User-Agent": "Nekomitai" }, rejectUnauthorized: false } as any,
        (res) => {
        const sc = res.statusCode || 0;
        if (sc >= 300 && sc < 400 && res.headers.location) {
          res.resume();
          if (redirects >= 5) return reject(new Error("Too many redirects"));
          return resolve(getText(res.headers.location, redirects + 1));
        }
        if (sc !== 200) {
          res.resume();
          return reject(new Error("List fetch " + sc));
        }
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      })
      .on("error", reject);
  });

const loadPackage = () => {
  if (!FiltersEngine) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("@ghostery/adblocker");
    FiltersEngine = pkg.FiltersEngine;
    RequestCls = pkg.Request;
    if (!FiltersEngine) throw new Error("adblocker package missing FiltersEngine");
  }
};

const buildFromNetwork = async (): Promise<void> => {
  const texts = await Promise.all(LISTS.map(getText));
  // enableCompression cuts the in-memory footprint substantially — important
  // inside CEP's render process where a big spike can OOM the panel.
  engine = FiltersEngine.parse(texts.join("\n"), { enableCompression: true });
  try {
    fs.writeFileSync(cachePath(), Buffer.from(engine.serialize()));
    fs.writeFileSync(
      stampPath(),
      JSON.stringify({ at: Date.now(), lists: LISTS })
    );
  } catch {
    /* cache is best-effort */
  }
  state.listVersion = new Date().toISOString().slice(0, 10);
};

const CACHE_TTL = 48 * 3600 * 1000; // refresh lists every 48h

/** Ensure the engine exists — from serialized cache if fresh, else rebuild.
 * Fully guarded: this promise NEVER rejects (an unhandled rejection here would
 * take down the whole gateway/Node context). Errors land in state.error. */
export const ensureEngine = (): Promise<void> => {
  if (ready) return ready;
  state.loading = true;
  state.error = null;
  ready = (async () => {
    try {
      loadPackage();
      try {
        const stamp = JSON.parse(fs.readFileSync(stampPath(), "utf8"));
        const fresh = Date.now() - stamp.at < CACHE_TTL;
        if (fresh && fs.existsSync(cachePath())) {
          engine = FiltersEngine.deserialize(fs.readFileSync(cachePath()));
          state.listVersion = new Date(stamp.at).toISOString().slice(0, 10);
        } else {
          await buildFromNetwork();
        }
      } catch {
        await buildFromNetwork();
      }
      state.ready = true;
    } catch (e) {
      // Build failed — record it, keep the gateway alive, allow a later retry.
      state.error = String(e && (e as any).message ? (e as any).message : e);
      engine = null;
      ready = null; // let a future enable/refresh try again
    } finally {
      state.loading = false;
    }
  })();
  return ready;
};

/** Enable/disable filtering. Awaits the engine build so callers get a
 * definitive ready/error state instead of polling forever. */
export const setConfig = async (
  cfg: Partial<Pick<AdblockState, "adblock" | "antitrack">>
): Promise<AdblockState> => {
  if (typeof cfg.adblock === "boolean") state.adblock = cfg.adblock;
  if (typeof cfg.antitrack === "boolean") state.antitrack = cfg.antitrack;
  if ((state.adblock || state.antitrack) && !engine) await ensureEngine();
  return getState();
};

export const getState = (): AdblockState => ({ ...state });

export const refreshLists = async (): Promise<AdblockState> => {
  loadPackage();
  await buildFromNetwork();
  state.ready = true;
  return getState();
};

/** True if this request should be blocked. */
export const shouldBlock = (
  url: string,
  sourceUrl: string,
  type: string
): boolean => {
  if (!engine || (!state.adblock && !state.antitrack)) return false;
  try {
    const { match } = engine.match(
      RequestCls.fromRawDetails({ type: type as any, url, sourceUrl })
    );
    if (match) state.blocked++;
    return match;
  } catch {
    return false;
  }
};

/** Prove the engine loads and matches known ad/tracker URLs (Diagnostics). */
export const selfTest = async (): Promise<{
  ok: boolean;
  listVersion: string | null;
  blocked: number;
  total: number;
  error?: string;
}> => {
  try {
    await ensureEngine();
    const urls = [
      "https://doubleclick.net/ad.js",
      "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
      "https://www.google-analytics.com/analytics.js",
      "https://cdn.jsdelivr.net/npm/x.js", // should NOT be blocked
    ];
    let blocked = 0;
    for (const u of urls) {
      const { match } = engine.match(
        RequestCls.fromRawDetails({ type: "script", url: u, sourceUrl: "https://example.com" })
      );
      if (match) blocked++;
    }
    return { ok: true, listVersion: state.listVersion, blocked, total: urls.length };
  } catch (e) {
    return { ok: false, listVersion: null, blocked: 0, total: 0, error: String(e) };
  }
};

/** Element-hiding CSS for a page (cosmetic filtering). */
export const cosmeticCss = (pageUrl: string): string => {
  if (!engine || !state.adblock) return "";
  try {
    const u = new URL(pageUrl);
    const { styles } = engine.getCosmeticsFilters({
      url: pageUrl,
      hostname: u.hostname,
      domain: u.hostname.split(".").slice(-2).join("."),
    });
    return styles || "";
  } catch {
    return "";
  }
};
