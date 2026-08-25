/**
 * Nekomitai Gateway — a loopback HTTP server running inside the panel's own
 * Node context. Serves the view-surface pages (so embeds get a real localhost
 * origin — Twitch's `parent` check needs it), resolves watch URLs to embed
 * URLs, and will grow the proxy (M4), adblock (M5), and downloads.
 *
 * Security: binds 127.0.0.1 only, requires a per-session token on every
 * request, and validates the Host header (DNS-rebinding guard).
 */
import { http, crypto, fs, path, os } from "../cep/node";
import { resolveEmbed } from "./embed";
import { renderViewPage } from "./view-page";
import { handleProxy, netTest } from "./proxy";
import { scRelated, scPlaylist } from "./sc-related";
import {
  spotifyStatus,
  spotifyPlayback,
  spotifyCommand,
  spotifyContext,
  setClientId,
  beginAuth,
  cancelAuth,
  spotifyLogout,
} from "./spotify";
import {
  clearCookies,
  importCookiesTxt,
  addCookieHeader,
  listDomains,
  clearDomain,
} from "./cookies";
import { downloadToCache } from "./downloads";
import { getState, setConfig, refreshLists, selfTest } from "./adblock";
import { startAeMeter, getAePeak } from "./ae-meter";
import { readJson, writeJson } from "./persist";
import type { IncomingMessage, ServerResponse } from "http";

export type GatewayInfo = {
  port: number;
  token: string;
  /** API origin the panel fetches (IPv4-pinned). */
  origin: string;
  /** Origin for view-surface iframes — a real hostname, because Twitch's
   * `parent` check wants `localhost`, not an IP. */
  viewOrigin: string;
};

const BASE_PORT = 45789;
const VERSION = "0.7.0";

let current: GatewayInfo | null = null;

export const getGateway = (): GatewayInfo | null => current;

const mk = (port: number, token: string): GatewayInfo => ({
  port,
  token,
  origin: `http://127.0.0.1:${port}`,
  viewOrigin: `http://localhost:${port}`,
});

// Persist {port, token} so that after a panel/render reload the new page reuses
// the still-alive gateway (or replaces it consistently) — prevents the panel
// from holding a stale token and getting 401s.
const gwFile = (): string => {
  const base =
    process.env.APPDATA ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : path.join(os.homedir(), ".config"));
  const dir = path.join(base, "Nekomitai");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return path.join(dir, "gateway.json");
};
const readGw = (): { port: number; token: string; version?: string } | null => {
  try {
    return JSON.parse(fs.readFileSync(gwFile(), "utf8"));
  } catch {
    return null;
  }
};
const writeGw = (v: { port: number; token: string }) => {
  try {
    fs.writeFileSync(gwFile(), JSON.stringify({ ...v, version: VERSION }));
  } catch {
    /* ignore */
  }
};

const probe = (port: number, token: string): Promise<boolean> =>
  new Promise((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: `/health?t=${token}`, timeout: 800 },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(res.statusCode === 200 && JSON.parse(d).ok === true);
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });

const listen = (preferred: number, token: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        handle(req, res, token);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    let attempts = 0;
    const tryPort = (port: number) => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && attempts < 30) {
          attempts++;
          tryPort(port + 1);
        } else {
          reject(e);
        }
      });
      server.listen(port, "127.0.0.1", () => {
        // Mirror on IPv6 loopback (Windows often resolves localhost to ::1).
        try {
          const s6 = http.createServer((req, res) => {
            try {
              handle(req, res, token);
            } catch (e) {
              res.writeHead(500);
              res.end(String(e));
            }
          });
          s6.on("error", () => undefined);
          s6.listen(port, "::1");
        } catch {
          /* IPv6 disabled */
        }
        resolve(port);
      });
    };
    tryPort(preferred);
  });

export const startGateway = async (): Promise<GatewayInfo> => {
  startAeMeter();
  if (current) return current;
  // Reuse a still-alive gateway from a prior page load (matching token AND
  // version, so an updated build never attaches to old server code).
  const saved = readGw();
  if (saved && saved.version === VERSION && (await probe(saved.port, saved.token))) {
    current = mk(saved.port, saved.token);
    return current;
  }
  const token = crypto.randomBytes(16).toString("hex");
  const port = await listen(saved?.port || BASE_PORT, token);
  writeGw({ port, token });
  current = mk(port, token);
  return current;
};

const handle = (
  req: IncomingMessage,
  res: ServerResponse,
  token: string
): void => {
  const host = String(req.headers.host || "");
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  const u = new URL(req.url || "/", `http://${host}`);

  if (u.searchParams.get("t") !== token) {
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end("Unauthorized");
    return;
  }

  const base = `http://${host}`;

  switch (u.pathname) {
    case "/health": {
      json(res, {
        ok: true,
        version: VERSION,
        node: process.versions.node,
        uptime: process.uptime(),
      });
      return;
    }
    case "/aepeak": {
      json(res, { ok: true, ...getAePeak() });
      return;
    }
    case "/embed/resolve": {
      const target = u.searchParams.get("url") || "";
      json(res, { ok: true, resolution: resolveEmbed(target) });
      return;
    }
    case "/view": {
      const target = u.searchParams.get("target") || "";
      const resolution = resolveEmbed(target);
      // Web tier: serve proxied content directly (no redirect hop).
      if (resolution.kind === "web") {
        handleProxy(resolution.url, `${base}/proxy?t=${token}`, base, req, res);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(renderViewPage(target, resolution));
      return;
    }
    case "/proxy": {
      const target = u.searchParams.get("url") || "";
      if (!/^https?:\/\//i.test(target)) {
        res.writeHead(400);
        res.end("Bad proxy target");
        return;
      }
      // A frame NAVIGATION (not a sub-resource) whose target belongs to the
      // embed/media tier gets the view page: clicking a YouTube/Vimeo/media
      // link inside a proxied web page switches the tab to the real player
      // instead of a broken proxied SPA. Sub-resources keep proxying as-is.
      const dest = String(req.headers["sec-fetch-dest"] || "");
      if (dest === "iframe" || dest === "frame" || dest === "document") {
        const resolution = resolveEmbed(target);
        if (resolution.kind !== "web") {
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(renderViewPage(target, resolution));
          return;
        }
      }
      // proxyBase already carries the token; proxify() appends &url=<target>
      handleProxy(target, `${base}/proxy?t=${token}`, base, req, res);
      return;
    }
    case "/sc/related": {
      const target = u.searchParams.get("url") || "";
      scRelated(target).then((r) => json(res, r));
      return;
    }
    case "/sc/playlist": {
      const target = u.searchParams.get("url") || "";
      scPlaylist(target).then((r) => json(res, r));
      return;
    }
    // ── Spotify Connect ─────────────────────────────────────────────────
    // Everything privileged (tokens, the OAuth exchange) stays here; the view
    // page only ever sees playback state and sends commands.
    case "/spotify/status": {
      json(res, spotifyStatus());
      return;
    }
    case "/spotify/config": {
      readBody(req).then((body) => {
        try {
          setClientId(String(JSON.parse(body || "{}").clientId || ""));
        } catch {
          /* ignore */
        }
        json(res, spotifyStatus());
      });
      return;
    }
    case "/spotify/auth": {
      // The panel opens the returned URL in the SYSTEM browser and then polls
      // /spotify/status — Spotify's consent screen refuses embedded webviews.
      const r = beginAuth();
      json(res, { ...r, status: spotifyStatus() });
      return;
    }
    case "/spotify/auth/cancel": {
      cancelAuth();
      json(res, spotifyStatus());
      return;
    }
    case "/spotify/logout": {
      spotifyLogout();
      json(res, spotifyStatus());
      return;
    }
    case "/spotify/state": {
      spotifyPlayback(u.searchParams.get("force") === "1").then((r) =>
        json(res, r)
      );
      return;
    }
    case "/spotify/cmd": {
      readBody(req).then((body) => {
        let cmd: any = {};
        try {
          cmd = JSON.parse(body || "{}");
        } catch {
          /* ignore */
        }
        spotifyCommand(cmd).then((r) => json(res, r));
      });
      return;
    }
    case "/spotify/context": {
      const kind = u.searchParams.get("kind") || "";
      const id = u.searchParams.get("id") || "";
      spotifyContext(kind, id).then((r) => json(res, r));
      return;
    }
    case "/nettest": {
      const target = u.searchParams.get("url") || "https://example.com/";
      netTest(target).then((r) => json(res, r));
      return;
    }
    case "/adblock/status": {
      json(res, { ok: true, ...getState() });
      return;
    }
    case "/adblock/selftest": {
      selfTest().then((r) => json(res, r));
      return;
    }
    case "/adblock/config": {
      readBody(req).then(async (body) => {
        let cfg: any = {};
        try {
          cfg = JSON.parse(body || "{}");
        } catch {
          /* ignore */
        }
        const s = await setConfig(cfg); // awaits engine build
        json(res, { ok: true, ...s });
      });
      return;
    }
    case "/adblock/update": {
      refreshLists().then(
        (s) => json(res, { ok: true, ...s }),
        (e) => json(res, { ok: false, error: String(e) })
      );
      return;
    }
    case "/download": {
      const target = u.searchParams.get("url") || "";
      if (!/^https?:\/\//i.test(target)) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: "Bad URL" }));
        return;
      }
      downloadToCache(target).then((r) => json(res, r));
      return;
    }
    case "/session": {
      if (req.method === "POST") {
        readBody(req).then((body) => {
          try {
            writeJson("session", JSON.parse(body || "{}"));
          } catch {
            /* ignore */
          }
          json(res, { ok: true });
        });
      } else {
        json(res, { ok: true, session: readJson("session") });
      }
      return;
    }
    case "/boards": {
      if (req.method === "POST") {
        readBody(req).then((body) => {
          try {
            writeJson("boards", JSON.parse(body || "{}"));
          } catch {
            /* ignore */
          }
          json(res, { ok: true });
        });
      } else {
        json(res, { ok: true, boards: readJson("boards") || {} });
      }
      return;
    }
    case "/cookies": {
      if (req.method === "GET") {
        json(res, { ok: true, domains: listDomains() });
        return;
      }
      if (req.method === "DELETE") {
        const domain = u.searchParams.get("domain");
        if (domain) clearDomain(domain);
        else clearCookies();
        json(res, { ok: true, domains: listDomains() });
        return;
      }
      readBody(req).then((body) => {
        let n = 0;
        try {
          const j = JSON.parse(body || "{}");
          if (j.action === "header" && j.domain && j.header)
            n = addCookieHeader(j.domain, j.header);
          else if (j.action === "cookiesTxt" && j.text)
            n = importCookiesTxt(j.text);
        } catch {
          // fall back: treat raw body as cookies.txt
          n = importCookiesTxt(body);
        }
        json(res, { ok: true, imported: n, domains: listDomains() });
      });
      return;
    }
    default: {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Not found" }));
    }
  }
};

const json = (res: ServerResponse, body: object) => {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
