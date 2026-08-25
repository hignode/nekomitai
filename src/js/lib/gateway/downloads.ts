/**
 * Minimal download manager: fetches a media URL server-side (through the
 * cookie jar, so authenticated media works) into a per-user cache folder and
 * returns the local path for ExtendScript import. SSE progress lands later;
 * for now it resolves once the file is written.
 */
import { http, https, fs, path, os } from "../cep/node";
import { cookieHeaderFor } from "./cookies";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export const cacheDir = (): string => {
  const base =
    process.env.APPDATA ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : path.join(os.homedir(), ".config"));
  const dir = path.join(base, "Nekomitai", "cache");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const sanitize = (name: string) =>
  name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "download";

const nameFromUrl = (target: string, contentType: string): string => {
  let base = "download";
  try {
    const p = new URL(target).pathname;
    const last = p.split("/").filter(Boolean).pop();
    if (last) base = last;
  } catch {
    /* keep default */
  }
  if (!/\.[a-z0-9]{1,5}$/i.test(base)) {
    const ext = (contentType.split(";")[0].split("/")[1] || "bin").replace(
      "jpeg",
      "jpg"
    );
    base += "." + ext;
  }
  return sanitize(base);
};

export const downloadToCache = (
  target: string,
  redirects = 0
): Promise<{ ok: true; path: string; name: string } | { ok: false; error: string }> =>
  new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      return resolve({ ok: false, error: "Bad URL" });
    }
    const mod = u.protocol === "http:" ? http : https;
    const cookie = cookieHeaderFor(u.hostname, u.pathname);
    // explicit options, not a URL object (CEP realm mismatch — see proxy.ts)
    const opts: any = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: (u.pathname || "/") + (u.search || ""),
      method: "GET",
      rejectUnauthorized: false,
      headers: { "User-Agent": UA, ...(cookie ? { Cookie: cookie } : {}) },
    };
    const req = mod.request(opts, (res) => {
        const sc = res.statusCode || 0;
        if (sc >= 300 && sc < 400 && res.headers.location) {
          res.resume();
          if (redirects >= 8)
            return resolve({ ok: false, error: "Too many redirects" });
          return resolve(
            downloadToCache(new URL(res.headers.location, u).href, redirects + 1)
          );
        }
        if (sc !== 200) {
          res.resume();
          return resolve({ ok: false, error: `Upstream ${sc}` });
        }
        const name = nameFromUrl(
          u.href,
          String(res.headers["content-type"] || "")
        );
        const dest = path.join(cacheDir(), name);
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve({ ok: true, path: dest, name })));
        out.on("error", (e) => resolve({ ok: false, error: String(e) }));
      }
    );
    req.on("error", (e) => resolve({ ok: false, error: String(e) }));
    req.setTimeout(60000, () => req.destroy(new Error("Download timeout")));
    req.end();
  });
