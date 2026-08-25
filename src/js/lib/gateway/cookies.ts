/**
 * Server-side cookie jar so logins persist across proxied (Web Mode) requests.
 *
 * PRIVACY / SECURITY: cookies are credentials. They are stored ONLY on this
 * machine, encrypted at rest, and sent back exclusively to the site they
 * belong to, through Nekomitai's local proxy. See vault.ts for what that
 * encryption does and does not protect against.
 */
import { readVault, writeVault } from "./vault";

type Cookie = {
  value: string;
  domain: string;
  path: string;
  expires?: number;
  secure?: boolean;
};

const jar = new Map<string, Cookie>(); // key: `${domain}|${path}|${name}`
let loaded = false;

const keyOf = (name: string, domain: string, path: string) =>
  `${domain}|${path}|${name}`;

// ── local encrypted storage ─────────────────────────────────────
const VAULT = "cookies.vault";
const KEYFILE = ".cookie-key";

const save = () => {
  writeVault(VAULT, KEYFILE, [...jar.entries()]);
};

const load = () => {
  if (loaded) return;
  loaded = true;
  const entries = readVault<[string, Cookie][]>(VAULT, KEYFILE);
  if (entries) for (const [k, v] of entries) jar.set(k, v);
};

// ── ingest from live responses ───────────────────────────────────────────
export const storeSetCookies = (setCookies: string[], reqHost: string) => {
  load();
  for (const raw of setCookies) {
    const parts = raw.split(";").map((p) => p.trim());
    const [nv, ...attrs] = parts;
    const eq = nv.indexOf("=");
    if (eq < 0) continue;
    const name = nv.slice(0, eq).trim();
    const value = nv.slice(eq + 1).trim();

    const cookie: Cookie = { value, domain: reqHost, path: "/" };
    for (const a of attrs) {
      const [k, v] = a.split("=").map((s) => s && s.trim());
      const kl = k.toLowerCase();
      if (kl === "domain" && v) cookie.domain = v.replace(/^\./, "");
      else if (kl === "path" && v) cookie.path = v;
      else if (kl === "secure") cookie.secure = true;
      else if (kl === "max-age" && v)
        cookie.expires = Date.now() + Number(v) * 1000;
      else if (kl === "expires" && v) {
        const t = Date.parse(v);
        if (!isNaN(t)) cookie.expires = t;
      }
    }
    const key = keyOf(name, cookie.domain, cookie.path);
    if (cookie.expires && cookie.expires < Date.now()) jar.delete(key);
    else jar.set(key, cookie);
  }
  save();
};

export const cookieHeaderFor = (host: string, path: string): string => {
  load();
  const now = Date.now();
  const out: string[] = [];
  for (const [key, c] of jar) {
    if (c.expires && c.expires < now) {
      jar.delete(key);
      continue;
    }
    const domainOk = host === c.domain || host.endsWith("." + c.domain);
    const pathOk = path.startsWith(c.path);
    if (domainOk && pathOk) out.push(`${key.split("|")[2]}=${c.value}`);
  }
  return out.join("; ");
};

// ── manual login (Settings) ──────────────────────────────────────────────
/** Add cookies from a `Cookie:`-header string (name=value; name2=value2) for
 * a domain. Returns how many were stored. */
export const addCookieHeader = (domain: string, header: string): number => {
  load();
  const d = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\./, "");
  let n = 0;
  for (const pair of header.split(/;\s*/)) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    jar.set(keyOf(name, d, "/"), { value, domain: d, path: "/" });
    n++;
  }
  save();
  return n;
};

/** Import Netscape `cookies.txt` format. */
export const importCookiesTxt = (text: string): number => {
  load();
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const f = line.split("\t");
    if (f.length < 7) continue;
    const [domain, , cpath, secure, expires, name, value] = f;
    const d = domain.replace(/^\./, "");
    jar.set(keyOf(name, d, cpath), {
      value,
      domain: d,
      path: cpath,
      secure: secure.toUpperCase() === "TRUE",
      expires: Number(expires) ? Number(expires) * 1000 : undefined,
    });
    n++;
  }
  save();
  return n;
};

/** Domains we hold cookies for, with counts (for the Settings list). */
export const listDomains = (): { domain: string; count: number }[] => {
  load();
  const counts = new Map<string, number>();
  for (const c of jar.values())
    counts.set(c.domain, (counts.get(c.domain) || 0) + 1);
  return [...counts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
};

export const clearDomain = (domain: string) => {
  load();
  const d = domain.replace(/^\./, "");
  for (const key of [...jar.keys()]) {
    if (key.startsWith(d + "|")) jar.delete(key);
  }
  save();
};

export const clearCookies = () => {
  jar.clear();
  save();
};
