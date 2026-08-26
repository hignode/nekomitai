/**
 * Web Mode proxy handler. Fetches a target server-side, strips the headers
 * that forbid framing (X-Frame-Options, CSP frame-ancestors), rewrites HTML/CSS
 * so sub-resources and navigation stay inside the proxy, and carries cookies
 * through the jar so logins work.
 *
 * Only HTML/CSS is buffered (it has to be, to rewrite it) — everything else
 * (images, video, fonts, downloads) is STREAMED straight through. Buffering
 * media used to hold entire files in the panel's memory, and a big video on a
 * proxied page could balloon the CEP process until it crashed. Range requests
 * pass through for the same reason: media seeks must not re-download files.
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
/** Hard cap for bodies we buffer to rewrite — a rewritable document larger
 * than this is pathological, and an unbounded buffer is an OOM waiting to
 * happen inside the CEP process. */
const MAX_REWRITE_BYTES = 32 * 1024 * 1024;

type FetchResult = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  finalUrl: string;
};

type StreamResult = {
  /** The upstream response, redirects already followed, body NOT consumed. */
  up: IncomingMessage;
  status: number;
  finalUrl: string;
};

// CEP's bundled Node often lacks a working root-CA store, so TLS verification
// fails on normal https. The first cert error flips a shared flag (net.ts, so
// the API client agrees) and everything after skips straight to the unverified
// path. (Acceptable for a display proxy on loopback; documented tradeoff.)

/** GET the target, following redirects, and resolve with the live response
 * stream — the caller decides whether to buffer (rewrite) or pipe it. */
const requestTarget = (
  target: string,
  extraHeaders: Record<string, string>,
  redirects = 0,
  insecure = isTlsInsecure()
): Promise<StreamResult> =>
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
        ...extraHeaders,
      },
    };
    const req = mod.request(opts, (res) => {
      const sc = res.statusCode || 0;
      const setCookie = res.headers["set-cookie"];
      if (setCookie) storeSetCookies(setCookie, u.hostname);

      // follow redirects (so login/OAuth chains complete)
      if (sc >= 300 && sc < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS)
          return reject(new Error("Too many redirects"));
        const next = new URL(res.headers.location, u).href;
        return resolve(requestTarget(next, extraHeaders, redirects + 1, insecure));
      }

      resolve({ up: res, status: sc, finalUrl: u.href });
    });
    req.on("error", (e: NodeJS.ErrnoException) => {
      // Retry once without TLS verification if the CA store is the problem.
      if (!insecure && isCertError(e)) {
        markTlsInsecure();
        resolve(requestTarget(target, extraHeaders, redirects, true));
        return;
      }
      reject(e);
    });
    req.setTimeout(20000, () => req.destroy(new Error("Upstream timeout")));
    req.end();
  });

/** Collect a (possibly partly-consumed) response body, bounded. */
const collectBody = (
  up: IncomingMessage,
  first: Buffer[],
  maxBytes: number
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [...first];
    let total = chunks.reduce((n, c) => n + c.length, 0);
    up.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        up.destroy();
        reject(new Error("Response too large to rewrite"));
        return;
      }
      chunks.push(c);
    });
    up.on("end", () => resolve(Buffer.concat(chunks)));
    up.on("error", reject);
  });

const decompress = (body: Buffer, enc: string): Buffer => {
  try {
    if (enc.includes("br")) return Buffer.from(zlib.brotliDecompressSync(body));
    if (enc.includes("gzip")) return Buffer.from(zlib.gunzipSync(body));
    if (enc.includes("deflate")) return Buffer.from(zlib.inflateSync(body));
  } catch {
    /* leave as-is */
  }
  return body;
};

/** Buffered fetch — for API-ish callers (netTest) that want the whole body. */
export const fetchTarget = (target: string): Promise<FetchResult> =>
  requestTarget(target, {}).then(({ up, status, finalUrl }) =>
    collectBody(up, [], MAX_REWRITE_BYTES).then((raw) => ({
      status,
      headers: up.headers,
      body: decompress(raw, String(up.headers["content-encoding"] || "")),
      finalUrl,
    }))
  );

/** Diagnostic: fetch a URL and report the outcome as data (not a page). */
export const netTest = (
  target: string
): Promise<{ ok: boolean; status?: number; bytes?: number; insecure?: boolean; error?: string }> =>
  fetchTarget(target).then(
    (r) => ({ ok: true, status: r.status, bytes: r.body.length, insecure: isTlsInsecure() }),
    (e) => ({ ok: false, error: String(e && e.code ? e.code + ": " + e.message : e) })
  );

const errorPage = (res: ServerResponse, e: unknown): void => {
  // Stay in-panel: show the error with a Retry (reload) — no handoff.
  try {
    res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!DOCTYPE html><meta charset="utf-8">
      <body style="font-family:Segoe UI,sans-serif;background:#141416;color:#c8cad2;
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        height:100vh;margin:0;text-align:center;gap:10px;padding:24px">
        <h1 style="font-size:15px;margin:0">Couldn't load this page</h1>
        <p style="font-size:12px;max-width:44ch;color:#8f97f8;word-break:break-all">${String(
          e && (e as any).message ? (e as any).message : e
        )}</p>
        <button style="background:#8f97f8;color:#141416;border:0;border-radius:5px;
          padding:7px 16px;font-weight:600;cursor:pointer"
          onclick="location.reload()">Retry</button>
      </body>`
    );
  } catch {
    /* socket already gone */
  }
};

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

  const range = req.headers.range;
  requestTarget(target, typeof range === "string" ? { Range: range } : {}).then(
    ({ up, status, finalUrl }) => {
      const ct = String(up.headers["content-type"] || "");
      const enc = String(up.headers["content-encoding"] || "");

      // Whitelist only safe response headers. Forwarding arbitrary upstream
      // headers made Node's http throw on malformed values (Wikipedia/Twitch),
      // which killed the response and left the iframe blank. We also never
      // forward X-Frame-Options / CSP (framing) or content-disposition
      // (would trigger a download instead of rendering).
      const sendRewritten = (raw: Buffer) => {
        const body0 = decompress(raw, enc);
        const outHeaders: Record<string, string> = {
          "Content-Type": ct || "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        };
        const looksHtml =
          ct.includes("text/html") ||
          ct.includes("xhtml") ||
          (!ct &&
            /^\s*<(?:!doctype|html)/i.test(body0.subarray(0, 200).toString("utf8")));

        let body: Buffer | string = body0;
        if (looksHtml) {
          let html = rewriteHtml(
            body0.toString("utf8"),
            finalUrl,
            proxyBase,
            new URL(finalUrl).origin
          );
          // cosmetic filtering: hide ad/tracker elements the network layer can't
          const css = cosmeticCss(finalUrl);
          if (css) {
            const style = `<style id="nm-cosmetics">${css}</style>`;
            html = /<\/head>/i.test(html)
              ? html.replace(/<\/head>/i, style + "</head>")
              : style + html;
          }
          body = html;
        } else if (ct.includes("text/css")) {
          body = rewriteCss(body0.toString("utf8"), finalUrl, proxyBase);
        }

        try {
          res.writeHead(status || 200, outHeaders);
          res.end(body);
        } catch (writeErr) {
          try {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Proxy write error: " + String(writeErr));
          } catch {
            /* socket already gone */
          }
        }
      };

      const buffered = (first: Buffer[]) =>
        collectBody(up, first, MAX_REWRITE_BYTES).then(sendRewritten, (e) =>
          errorPage(res, e)
        );

      // Pass-through path: pipe the body as it arrives, keeping the headers
      // media playback needs (length, ranges, encoding).
      const stream = (first?: Buffer) => {
        const outHeaders: Record<string, string> = {
          "Content-Type": ct || "application/octet-stream",
          "Cache-Control": "no-store",
        };
        const keep: Record<string, string> = {
          "content-length": "Content-Length",
          "content-range": "Content-Range",
          "accept-ranges": "Accept-Ranges",
          "content-encoding": "Content-Encoding",
        };
        for (const k of Object.keys(keep)) {
          const v = up.headers[k];
          if (typeof v === "string") outHeaders[keep[k]] = v;
        }
        try {
          res.writeHead(status || 200, outHeaders);
          if (first) res.write(first);
        } catch {
          up.destroy();
          return;
        }
        up.pipe(res);
        // a closed tab / aborted load must not keep the upstream download alive
        res.on("close", () => up.destroy());
        up.on("error", () => {
          try {
            res.destroy();
          } catch {
            /* already gone */
          }
        });
      };

      const isRanged = status === 206;
      if (!isRanged && (ct.includes("text/html") || ct.includes("xhtml") || ct.includes("text/css"))) {
        buffered([]);
        return;
      }
      if (!ct && !isRanged && !enc) {
        // No content-type: sniff the FIRST chunk only. Typeless HTML still
        // gets rewritten; typeless media streams instead of being buffered.
        let decided = false;
        up.once("data", (c: Buffer) => {
          decided = true;
          if (/^\s*<(?:!doctype|html)/i.test(c.subarray(0, 200).toString("utf8")))
            buffered([c]);
          else stream(c);
        });
        up.once("end", () => {
          if (!decided) sendRewritten(Buffer.alloc(0)); // empty body
        });
        up.once("error", (e) => {
          if (!decided) errorPage(res, e);
        });
        return;
      }
      stream();
    },
    (e) => errorPage(res, e)
  );
};
