/**
 * Web Mode proxy handler. Fetches a target server-side, strips the headers
 * that forbid framing (X-Frame-Options, CSP frame-ancestors), rewrites HTML/CSS
 * so sub-resources and navigation stay inside the proxy, and carries cookies
 * through the jar so logins work. Returns everything else as a raw stream.
 */
import { http, https, zlib } from "../cep/node";
import { isCertError, isTlsInsecure, markTlsInsecure } from "./net";
import type { IncomingMessage, ServerResponse } from "http";
import { cookieHeaderFor, storeSetCookies } from "./cookies";
import { rewriteHtml, rewriteCss } from "./rewrite";
import { shouldBlock, cosmeticCss } from "./adblock";

/** Map Chromium's Sec-Fetch-Dest to an adblocker request type. */
const destToType = (dest: string): string => {
  switch (dest) {
    case "script":
      return "script";
    case "style":
      return "stylesheet";
    case "image":
      return "image";
    case "font":
      return "font";
    case "video":
    case "audio":
      return "media";
    case "empty":
      return "xmlhttprequest";
    case "iframe":
    case "frame":
      return "sub_frame";
    default:
      return "other";
  }
};

/** Recover the real page URL from the proxied request's Referer. The top
 * document is served via /view?target=…, sub-resources via /proxy?url=…, so
 * check both. */
const sourceFromReferer = (referer: string | undefined): string => {
  if (!referer) return "";
  try {
    const sp = new URL(referer).searchParams;
    return sp.get("url") || sp.get("target") || "";
  } catch {
    return "";
  }
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const MAX_REDIRECTS = 8;

type FetchResult = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  finalUrl: string;
};

// CEP's bundled Node often lacks a working root-CA store, so TLS verification
// fails on normal https. The first cert error flips a shared flag (net.ts, so
// the API client agrees) and everything after skips straight to the unverified
// path. (Acceptable for a display proxy on loopback; documented tradeoff.)

export const fetchTarget = (
  target: string,
  redirects = 0,
  insecure = isTlsInsecure()
): Promise<FetchResult> =>
  new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(target);
    } catch (e) {
      return reject(new Error("Bad URL: " + target));
    }
    const mod = u.protocol === "http:" ? http : https;
    const cookie = cookieHeaderFor(u.hostname, u.pathname);
    // Build explicit options (NOT a URL object): CEP's panel-realm URL is a
    // different class than Node's, so passing it to request() is misparsed
    // (ERR_INVALID_ARG_TYPE "listener must be a function").
    const opts: any = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: (u.pathname || "/") + (u.search || ""),
      method: "GET",
      rejectUnauthorized: !insecure,
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    };
    const req = mod.request(
      opts,
      (res) => {
        const sc = res.statusCode || 0;
        const setCookie = res.headers["set-cookie"];
        if (setCookie) storeSetCookies(setCookie, u.hostname);

        // follow redirects (so login/OAuth chains complete)
        if (sc >= 300 && sc < 400 && res.headers.location) {
          res.resume();
          if (redirects >= MAX_REDIRECTS)
            return reject(new Error("Too many redirects"));
          const next = new URL(res.headers.location, u).href;
          return resolve(fetchTarget(next, redirects + 1, insecure));
        }

        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          let body = Buffer.concat(chunks);
          const enc = String(res.headers["content-encoding"] || "");
          try {
            if (enc.includes("br"))
              body = Buffer.from(zlib.brotliDecompressSync(body));
            else if (enc.includes("gzip"))
              body = Buffer.from(zlib.gunzipSync(body));
            else if (enc.includes("deflate"))
              body = Buffer.from(zlib.inflateSync(body));
          } catch {
            /* leave as-is */
          }
          resolve({
            status: sc,
            headers: res.headers,
            body,
            finalUrl: u.href,
          });
        });
      }
    );
    req.on("error", (e: NodeJS.ErrnoException) => {
      // Retry once without TLS verification if the CA store is the problem.
      if (!insecure && isCertError(e)) {
        markTlsInsecure();
        resolve(fetchTarget(target, redirects, true));
        return;
      }
      reject(e);
    });
    req.setTimeout(20000, () => req.destroy(new Error("Upstream timeout")));
    req.end();
  });

/** Diagnostic: fetch a URL and report the outcome as data (not a page). */
export const netTest = (
  target: string
): Promise<{ ok: boolean; status?: number; bytes?: number; insecure?: boolean; error?: string }> =>
  fetchTarget(target).then(
    (r) => ({ ok: true, status: r.status, bytes: r.body.length, insecure: isTlsInsecure() }),
    (e) => ({ ok: false, error: String(e && e.code ? e.code + ": " + e.message : e) })
  );

export const handleProxy = (
  target: string,
  proxyBase: string,
  proxyOrigin: string,
  req: IncomingMessage,
  res: ServerResponse
): void => {
  // Adblock: gate sub-resources (never the top document) before fetching.
  const dest = String(req.headers["sec-fetch-dest"] || "");
  if (dest && dest !== "document") {
    const type = destToType(dest);
    const source = sourceFromReferer(req.headers.referer);
    if (shouldBlock(target, source, type)) {
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
  }

  fetchTarget(target).then(
    (r) => {
      const ct = String(r.headers["content-type"] || "");
      // Whitelist only safe response headers. Forwarding arbitrary upstream
      // headers made Node's http throw on malformed values (Wikipedia/Twitch),
      // which killed the response and left the iframe blank. We also never
      // forward X-Frame-Options / CSP (framing) or content-disposition
      // (would trigger a download instead of rendering).
      const outHeaders: Record<string, string> = {
        "Content-Type": ct || "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      };

      const looksHtml =
        ct.includes("text/html") ||
        ct.includes("xhtml") ||
        (!ct && /^\s*<(?:!doctype|html)/i.test(r.body.subarray(0, 200).toString("utf8")));

      let body: Buffer | string = r.body;
      if (looksHtml) {
        let html = rewriteHtml(
          r.body.toString("utf8"),
          r.finalUrl,
          proxyBase,
          new URL(r.finalUrl).origin
        );
        // cosmetic filtering: hide ad/tracker elements the network layer can't
        const css = cosmeticCss(r.finalUrl);
        if (css) {
          const style = `<style id="nm-cosmetics">${css}</style>`;
          html = /<\/head>/i.test(html)
            ? html.replace(/<\/head>/i, style + "</head>")
            : style + html;
        }
        body = html;
      } else if (ct.includes("text/css")) {
        body = rewriteCss(r.body.toString("utf8"), r.finalUrl, proxyBase);
      }

      try {
        res.writeHead(r.status || 200, outHeaders);
        res.end(body);
      } catch (writeErr) {
        try {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Proxy write error: " + String(writeErr));
        } catch {
          /* socket already gone */
        }
      }
    },
    (e) => {
      // Stay in-panel: show the error with a Retry (reload) — no handoff.
      res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!DOCTYPE html><meta charset="utf-8">
        <body style="font-family:Segoe UI,sans-serif;background:#141416;color:#c8cad2;
          display:flex;flex-direction:column;align-items:center;justify-content:center;
          height:100vh;margin:0;text-align:center;gap:10px;padding:24px">
          <h1 style="font-size:15px;margin:0">Couldn't load this page</h1>
          <p style="font-size:12px;max-width:44ch;color:#8f97f8;word-break:break-all">${String(
            e && e.message ? e.message : e
          )}</p>
          <button style="background:#8f97f8;color:#141416;border:0;border-radius:5px;
            padding:7px 16px;font-weight:600;cursor:pointer"
            onclick="location.reload()">Retry</button>
        </body>`
      );
    }
  );
};
