/**
 * Spotify Connect — the answer to CEP having no DRM.
 *
 * The wall this works around: the Spotify embed plays 30-second previews for
 * anonymous listeners, and full tracks need Widevine. CEP 12 ships Chromium 99
 * with no CDM, so full playback *inside the panel* is impossible — cookies
 * don't change that, and no amount of proxying does either. What IS possible,
 * and is the officially blessed route, is remote control: the Web API drives
 * whatever Spotify client the user already has running (desktop app, phone,
 * speaker). The audio comes out of the real app; the panel is the remote.
 *
 * Two consequences the UI has to be honest about:
 *  - Transport control requires Spotify **Premium**. Free accounts can still
 *    browse their playlists here, but every play/pause call answers 403.
 *  - It requires the user's OWN client ID. Spotify apps start in development
 *    mode, capped at 25 manually-added users, and lifting that needs a quota
 *    review Nekomitai is not eligible for (it isn't a hosted service). So the
 *    user creates a free app at developer.spotify.com/dashboard and pastes the
 *    ID in Settings. There is no secret to protect: this is a PKCE public
 *    client, which is exactly the flow Spotify prescribes for desktop apps.
 *
 * The callback listener is deliberately NOT the Gateway. Spotify demands an
 * exact redirect-URI match, and the Gateway's port floats (it hunts upward
 * from 45789 when a port is taken), so a URI registered once would eventually
 * stop matching. Instead a one-shot server binds a fixed port for the few
 * seconds the flow is open, answers exactly one path, and closes itself. It
 * also keeps the token-bearing redirect off the surface that serves hostile
 * web content.
 *
 * Tokens are credentials: encrypted at rest via vault.ts, and sent nowhere
 * except accounts.spotify.com / api.spotify.com.
 */
import { http, crypto } from "../cep/node";
import { apiJson } from "./net";
import { readVault, writeVault, dropVault } from "./vault";
import { readJson, writeJson } from "./persist";
import type { IncomingMessage, ServerResponse } from "http";

const AUTH_HOST = "https://accounts.spotify.com";
const API = "https://api.spotify.com/v1";

/** Fixed, because the user registers it by hand in Spotify's dashboard. Kept
 * clear of the Gateway's 45789+30 port-hunting range. */
export const AUTH_PORT = 45899;
export const REDIRECT_URI = `http://127.0.0.1:${AUTH_PORT}/callback`;

/** Read playback + library, write playback. No user-data writes: Nekomitai
 * never modifies playlists, follows, or saved tracks. */
const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
].join(" ");

const VAULT = "spotify.vault";
const KEYFILE = ".token-key";

type Tokens = { access: string; refresh: string; expires: number };
type Profile = { id: string; name: string; product: string; country: string };

let loaded = false;
let clientId = "";
let tokens: Tokens | null = null;
let profile: Profile | null = null;
let refreshing: Promise<boolean> | null = null;
let lastError: string | null = null;

/** The live auth flow, while one is open. */
let flow: {
  verifier: string;
  state: string;
  server: any;
  timer: ReturnType<typeof setTimeout>;
} | null = null;

const load = () => {
  if (loaded) return;
  loaded = true;
  clientId = String(readJson("spotify")?.clientId || "");
  tokens = readVault<Tokens>(VAULT, KEYFILE);
};

const saveTokens = () => {
  if (tokens) writeVault(VAULT, KEYFILE, tokens);
  else dropVault(VAULT);
};

/** Synchronous, because resolveEmbed() is a pure function and has to decide
 * between the Connect page and the preview embed without awaiting. */
export const isSpotifyAuthorized = (): boolean => {
  load();
  return !!tokens;
};

// ── PKCE ─────────────────────────────────────────────────────────────────
const b64url = (b: Buffer): string =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const challengeFor = (verifier: string): string =>
  b64url(crypto.createHash("sha256").update(verifier).digest());

const form = (o: Record<string, string>): string =>
  Object.keys(o)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(o[k])}`)
    .join("&");

const qs = (o: Record<string, string | undefined>): string => {
  const parts = Object.keys(o)
    .filter((k) => o[k] !== undefined && o[k] !== "")
    .map((k) => `${k}=${encodeURIComponent(String(o[k]))}`);
  return parts.length ? "?" + parts.join("&") : "";
};

// ── config ───────────────────────────────────────────────────────────────
export const setClientId = (id: string): void => {
  load();
  clientId = id.trim();
  writeJson("spotify", { clientId });
  lastError = null;
};

export const spotifyLogout = (): void => {
  load();
  tokens = null;
  profile = null;
  lastError = null;
  snapshot = null;
  saveTokens();
  closeFlow();
};

export type SpotifyStatus = {
  ok: true;
  configured: boolean;
  authorized: boolean;
  pending: boolean;
  /** Premium is required for transport; browsing works without it. */
  premium: boolean;
  user: string | null;
  clientId: string;
  redirectUri: string;
  error: string | null;
};

export const spotifyStatus = (): SpotifyStatus => {
  load();
  return {
    ok: true,
    configured: !!clientId,
    authorized: !!tokens,
    pending: !!flow,
    premium: profile?.product === "premium",
    user: profile?.name || null,
    clientId,
    redirectUri: REDIRECT_URI,
    error: lastError,
  };
};

// ── authorization-code + PKCE flow ───────────────────────────────────────
const closeFlow = () => {
  if (!flow) return;
  clearTimeout(flow.timer);
  try {
    flow.server.close();
  } catch {
    /* already closed */
  }
  flow = null;
};

/** Escaped: `detail` can carry Spotify's own error_description text. */
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const donePage = (rawTitle: string, rawDetail: string) => {
  const title = esc(rawTitle);
  const detail = esc(rawDetail);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Nekomitai</title><style>
body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;
justify-content:center;gap:10px;background:#141416;color:#c8cad2;
font-family:'Segoe UI',system-ui,sans-serif;text-align:center;padding:24px}
h1{font-size:16px;margin:0;color:#e8e9ee}
p{font-size:13px;margin:0;max-width:46ch;line-height:1.6}
</style></head><body><h1>${title}</h1><p>${detail}</p>
<p style="color:#8b8e99">You can close this tab and go back to After Effects.</p>
</body></html>`;
};

const exchange = async (code: string, verifier: string): Promise<void> => {
  const { status, json } = await apiJson(`${AUTH_HOST}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  if (status !== 200 || !json?.access_token)
    throw new Error(
      json?.error_description || json?.error || `token exchange HTTP ${status}`
    );
  tokens = {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  };
  saveTokens();
  await loadProfile();
};

/**
 * Start the flow. Returns the URL the PANEL must open in the system browser —
 * Spotify's consent screen refuses to render inside an embedded webview, and
 * we would not want it to anyway: the user should be typing their password in
 * their own browser, not in ours.
 */
export const beginAuth = (): { ok: boolean; url?: string; error?: string } => {
  load();
  if (!clientId)
    return { ok: false, error: "Add your Spotify app's Client ID first." };
  closeFlow();
  lastError = null;

  const verifier = b64url(crypto.randomBytes(64));
  const state = crypto.randomBytes(16).toString("hex");

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url || "/", `http://127.0.0.1:${AUTH_PORT}`);
    if (u.pathname !== "/callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const err = u.searchParams.get("error");
    const code = u.searchParams.get("code");
    const gotState = u.searchParams.get("state");
    const finish = (title: string, detail: string) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(donePage(title, detail));
      closeFlow();
    };
    if (err) {
      lastError = `Spotify said: ${err}`;
      finish("Not connected", "You declined, or Spotify refused the request.");
      return;
    }
    if (!code || gotState !== state) {
      // A missing/mismatched state means this redirect is not ours — never
      // exchange it.
      lastError = "Authorization response did not match this request.";
      finish(
        "Not connected",
        "The response didn't match the request Nekomitai started."
      );
      return;
    }
    exchange(code, verifier).then(
      () =>
        finish(
          "Spotify connected",
          "Nekomitai can now control playback in your Spotify app."
        ),
      (e) => {
        lastError = String(e?.message || e);
        finish("Couldn't finish connecting", lastError);
      }
    );
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    lastError =
      e.code === "EADDRINUSE"
        ? `Port ${AUTH_PORT} is busy, so the Spotify sign-in can't be received. Close whatever is using it and try again.`
        : String(e.message || e);
    closeFlow();
  });

  try {
    server.listen(AUTH_PORT, "127.0.0.1");
  } catch (e) {
    return { ok: false, error: String(e) };
  }

  // Nothing should be able to leave a listener open indefinitely.
  const timer = setTimeout(
    () => {
      lastError = "Sign-in timed out. Try connecting again.";
      closeFlow();
    },
    5 * 60 * 1000
  );

  flow = { verifier, state, server, timer };

  const url =
    `${AUTH_HOST}/authorize?` +
    form({
      client_id: clientId,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      code_challenge_method: "S256",
      code_challenge: challengeFor(verifier),
      state,
      scope: SCOPES,
    });
  return { ok: true, url };
};

export const cancelAuth = (): void => {
  closeFlow();
};

// ── tokens ───────────────────────────────────────────────────────────────
const doRefresh = async (): Promise<boolean> => {
  if (!tokens?.refresh || !clientId) return false;
  const { status, json } = await apiJson(`${AUTH_HOST}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh,
      client_id: clientId,
    }),
  });
  if (status !== 200 || !json?.access_token) {
    // A revoked grant is terminal — drop it, so the UI says "connect again"
    // instead of retrying a dead refresh token forever.
    if (status === 400 || status === 401) {
      tokens = null;
      profile = null;
      saveTokens();
      lastError = "Spotify sign-in expired — connect again.";
    }
    return false;
  }
  tokens = {
    access: json.access_token,
    // Spotify rotates refresh tokens on some grants and omits it on others.
    refresh: json.refresh_token || tokens.refresh,
    expires: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  };
  saveTokens();
  return true;
};

/** Single-flight: a view page polling /state while a command runs must not
 * kick off two refreshes and have the loser overwrite the winner's token. */
const ensureToken = async (): Promise<boolean> => {
  load();
  if (!tokens) return false;
  if (Date.now() < tokens.expires - 60_000) return true;
  if (!refreshing) refreshing = doRefresh().finally(() => (refreshing = null));
  return refreshing;
};

// ── Web API ──────────────────────────────────────────────────────────────
type ApiResult = { status: number; json: any };

const call = async (
  method: string,
  path: string,
  body?: unknown,
  retry = true
): Promise<ApiResult> => {
  if (!(await ensureToken())) return { status: 401, json: null };
  const res = await apiJson(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${tokens!.access}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry) {
    if (!refreshing) refreshing = doRefresh().finally(() => (refreshing = null));
    if (await refreshing) return call(method, path, body, false);
  }
  return res;
};

const loadProfile = async (): Promise<void> => {
  const { status, json } = await call("GET", "/me");
  if (status === 200 && json)
    profile = {
      id: String(json.id || ""),
      name: String(json.display_name || json.id || "Spotify user"),
      product: String(json.product || ""),
      country: String(json.country || ""),
    };
};

/** Turn Spotify's status codes into something a person can act on. */
const explain = (status: number, json: any): string => {
  const reason = json?.error?.reason || "";
  if (status === 401) return "Spotify sign-in expired — connect again in Settings.";
  if (reason === "PREMIUM_REQUIRED")
    return "Spotify Premium is required to control playback.";
  if (reason === "NO_ACTIVE_DEVICE" || status === 404)
    return "No Spotify device is active — open Spotify on your computer or phone, then try again.";
  // 403 without a reason is usually Premium, but not always (market
  // restrictions land here too) — lead with Spotify's own message if it gave
  // one rather than asserting the wrong cause.
  if (status === 403)
    return (
      json?.error?.message ||
      "Spotify refused that — controlling playback requires Premium."
    );
  if (status === 429) return "Spotify is rate-limiting; try again in a moment.";
  return json?.error?.message || `Spotify API error ${status}`;
};

const imageOf = (images: any): string =>
  (Array.isArray(images) &&
    images.length &&
    String(images[images.length - 1]?.url)) ||
  "";

// ── player state ─────────────────────────────────────────────────────────
export type SpotifyPlayback = {
  ok: boolean;
  authorized: boolean;
  premium: boolean;
  active: boolean;
  playing: boolean;
  progressMs: number;
  durationMs: number;
  volume: number | null;
  shuffle: boolean;
  repeat: string;
  item: { uri: string; name: string; artist: string; image: string } | null;
  contextUri: string | null;
  devices: { id: string; name: string; type: string; active: boolean }[];
  error?: string;
};

const EMPTY: SpotifyPlayback = {
  ok: true,
  authorized: false,
  premium: false,
  active: false,
  playing: false,
  progressMs: 0,
  durationMs: 0,
  volume: null,
  shuffle: false,
  repeat: "off",
  item: null,
  contextUri: null,
  devices: [],
};

// Coalesce: every open Spotify tab runs its own poll loop, so without this a
// second tab would double the API call rate against a 180/min budget.
let snapshot: { at: number; value: SpotifyPlayback } | null = null;
let inflight: Promise<SpotifyPlayback> | null = null;
const SNAPSHOT_MS = 900;

const fetchPlayback = async (): Promise<SpotifyPlayback> => {
  load();
  if (!tokens) return { ...EMPTY };
  if (!profile) await loadProfile();

  const [state, devs] = await Promise.all([
    call("GET", "/me/player"),
    call("GET", "/me/player/devices"),
  ]);

  const devices = ((devs.json?.devices as any[]) || []).map((d) => ({
    id: String(d.id || ""),
    name: String(d.name || ""),
    type: String(d.type || ""),
    active: !!d.is_active,
  }));

  const base: SpotifyPlayback = {
    ...EMPTY,
    authorized: true,
    premium: profile?.product === "premium",
    devices,
  };

  if (state.status === 401)
    return { ...base, ok: false, error: explain(401, state.json) };
  // 204 = authorized, but nothing is playing anywhere right now.
  if (state.status === 204 || !state.json) return base;
  if (state.status !== 200)
    return { ...base, ok: false, error: explain(state.status, state.json) };

  const j = state.json;
  const it = j.item;
  return {
    ...base,
    active: true,
    playing: !!j.is_playing,
    progressMs: Number(j.progress_ms) || 0,
    durationMs: Number(it?.duration_ms) || 0,
    volume:
      typeof j.device?.volume_percent === "number" ? j.device.volume_percent : null,
    shuffle: !!j.shuffle_state,
    repeat: String(j.repeat_state || "off"),
    item: it
      ? {
          uri: String(it.uri || ""),
          name: String(it.name || ""),
          artist: Array.isArray(it.artists)
            ? it.artists.map((a: any) => a.name).join(", ")
            : String(it.show?.name || ""),
          image: imageOf(it.album?.images || it.images),
        }
      : null,
    contextUri: j.context?.uri ? String(j.context.uri) : null,
  };
};

export const spotifyPlayback = (force = false): Promise<SpotifyPlayback> => {
  if (!force && snapshot && Date.now() - snapshot.at < SNAPSHOT_MS)
    return Promise.resolve(snapshot.value);
  if (inflight) return inflight;
  inflight = fetchPlayback()
    .then((v) => {
      snapshot = { at: Date.now(), value: v };
      return v;
    })
    .catch((e) => ({ ...EMPTY, ok: false, error: String(e) }))
    .then((v) => {
      inflight = null;
      return v;
    });
  return inflight;
};

// ── transport ────────────────────────────────────────────────────────────
export type SpotifyCommand = {
  action:
    | "play"
    | "pause"
    | "next"
    | "previous"
    | "seek"
    | "volume"
    | "transfer"
    | "shuffle"
    | "repeat";
  /** A single track/episode to play. */
  uri?: string;
  /** Playlist/album to play within, so the rest stays queued behind it. */
  contextUri?: string;
  positionMs?: number;
  volumePercent?: number;
  deviceId?: string;
  on?: boolean;
  mode?: string;
};

/** Spotify refuses transport with no active device. Having the app open but
 * idle is the normal state when you paste a link into AE, so pick a device
 * and hand playback to it once rather than making the user go click Spotify. */
const pickDevice = async (): Promise<string | null> => {
  const { status, json } = await call("GET", "/me/player/devices");
  if (status !== 200) return null;
  const list = (json?.devices as any[]) || [];
  const best =
    list.find((d) => d.is_active) ||
    list.find((d) => !d.is_restricted && d.type === "Computer") ||
    list.find((d) => !d.is_restricted) ||
    list[0];
  return best?.id ? String(best.id) : null;
};

export const spotifyCommand = async (
  cmd: SpotifyCommand
): Promise<{ ok: boolean; error?: string }> => {
  load();
  if (!tokens) return { ok: false, error: "Spotify isn't connected." };

  const run = (deviceId?: string): Promise<ApiResult> => {
    const dev = { device_id: deviceId };
    switch (cmd.action) {
      case "play": {
        const body: any = {};
        if (cmd.contextUri) {
          body.context_uri = cmd.contextUri;
          if (cmd.uri) body.offset = { uri: cmd.uri };
        } else if (cmd.uri) {
          body.uris = [cmd.uri];
        }
        if (typeof cmd.positionMs === "number") body.position_ms = cmd.positionMs;
        // An empty body means "resume whatever is loaded" — which is exactly
        // what releasing an auto-duck needs.
        return call("PUT", "/me/player/play" + qs(dev), body);
      }
      case "pause":
        return call("PUT", "/me/player/pause" + qs(dev));
      case "next":
        return call("POST", "/me/player/next" + qs(dev));
      case "previous":
        return call("POST", "/me/player/previous" + qs(dev));
      case "seek":
        return call(
          "PUT",
          "/me/player/seek" +
            qs({ position_ms: String(Math.max(0, cmd.positionMs || 0)), ...dev })
        );
      case "volume":
        return call(
          "PUT",
          "/me/player/volume" +
            qs({
              volume_percent: String(
                Math.max(0, Math.min(100, Math.round(cmd.volumePercent ?? 100)))
              ),
              ...dev,
            })
        );
      case "shuffle":
        return call(
          "PUT",
          "/me/player/shuffle" + qs({ state: String(!!cmd.on), ...dev })
        );
      case "repeat":
        return call(
          "PUT",
          "/me/player/repeat" + qs({ state: cmd.mode || "off", ...dev })
        );
      case "transfer":
        return call("PUT", "/me/player", {
          device_ids: [cmd.deviceId],
          play: true,
        });
      default:
        return Promise.resolve({
          status: 400,
          json: { error: { message: "Unknown command" } },
        });
    }
  };

  try {
    let res = await run(cmd.deviceId);
    if (res.status === 404 && !cmd.deviceId) {
      const id = await pickDevice();
      if (id) res = await run(id);
    }
    if (res.status >= 200 && res.status < 300) {
      snapshot = null; // the next poll must see the result, not a stale one
      return { ok: true };
    }
    return { ok: false, error: explain(res.status, res.json) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
};

// ── browsable context (playlists, albums, the user's library) ─────────────
export type SpotifyItem = {
  uri: string;
  /** open.spotify.com link, for items you navigate to rather than play. */
  href: string;
  name: string;
  subtitle: string;
  image: string;
  durationMs: number;
  /** "track" | "episode" | "playlist" | "album" */
  kind: string;
};

export type SpotifyContext = {
  ok: boolean;
  kind: string;
  uri: string | null;
  name: string;
  subtitle: string;
  image: string;
  /** True when items are playable *inside* `uri`, so clicking track 7 leaves
   * the rest of the playlist queued behind it. */
  playableContext: boolean;
  items: SpotifyItem[];
  error?: string;
};

const webUrl = (kind: string, id: string) => `https://open.spotify.com/${kind}/${id}`;

const artistsOf = (x: any): string =>
  Array.isArray(x?.artists) ? x.artists.map((a: any) => a.name).join(", ") : "";

const trackItem = (t: any, albumImages?: any): SpotifyItem => ({
  uri: String(t?.uri || ""),
  href: t?.id ? webUrl(t.type === "episode" ? "episode" : "track", t.id) : "",
  name: String(t?.name || ""),
  subtitle: artistsOf(t) || String(t?.show?.name || ""),
  image: imageOf(t?.album?.images || t?.images || albumImages),
  durationMs: Number(t?.duration_ms) || 0,
  kind: String(t?.type || "track"),
});

/** Follow Spotify's `next` links. Capped — a 10k-track playlist is not worth
 * 100 sequential round-trips before the page can render, but the cap is high
 * enough that any humanly-curated playlist arrives whole. A failed page keeps
 * what already arrived and says why, instead of silently rendering nothing. */
const paged = async (
  path: string,
  cap = 1000
): Promise<{ items: any[]; error: string | null }> => {
  const out: any[] = [];
  let error: string | null = null;
  let next: string | null = path;
  while (next && out.length < cap) {
    const res: ApiResult = await call("GET", next);
    if (res.status !== 200 || !res.json) {
      error = explain(res.status, res.json);
      break;
    }
    out.push(...((res.json.items as any[]) || []));
    const n: string | null = res.json.next || null;
    next = n ? n.replace(API, "") : null;
  }
  return { items: out.slice(0, cap), error };
};

/**
 * Resolve what a Spotify link points at into a title plus a track list the
 * view page can render. `library` is the synthetic context for
 * open.spotify.com itself, which has no proxyable page at all.
 */
export const spotifyContext = async (
  kind: string,
  id: string
): Promise<SpotifyContext> => {
  load();
  const fail = (error: string): SpotifyContext => ({
    ok: false,
    kind,
    uri: null,
    name: "",
    subtitle: "",
    image: "",
    playableContext: false,
    items: [],
    error,
  });
  if (!tokens) return fail("Spotify isn't connected.");
  if (!profile) await loadProfile();

  try {
    switch (kind) {
      case "library": {
        const { items, error } = await paged("/me/playlists?limit=50");
        const list = items.filter(Boolean);
        return {
          ok: true,
          kind,
          uri: null,
          name: profile?.name ? `${profile.name}'s playlists` : "Your playlists",
          subtitle: `${list.length} playlist${list.length === 1 ? "" : "s"}`,
          image: "",
          playableContext: false,
          items: list.map((p: any) => {
            // Newer apps get the renamed shape (`items`, not `tracks`) —
            // read both; omit the count rather than print a lying "0 tracks"
            // when neither generation carries one.
            const total =
              typeof p.tracks?.total === "number"
                ? p.tracks.total
                : typeof p.items?.total === "number"
                  ? p.items.total
                  : null;
            const owner = String(p.owner?.display_name || "");
            return {
              uri: String(p.uri || ""),
              href: p.id ? webUrl("playlist", p.id) : "",
              name: String(p.name || ""),
              subtitle:
                [
                  total !== null
                    ? `${total} track${total === 1 ? "" : "s"}`
                    : "",
                  owner,
                ]
                  .filter(Boolean)
                  .join(" · ") || "Playlist",
              image: imageOf(p.images),
              durationMs: 0,
              kind: "playlist",
            };
          }),
          error: error || undefined,
        };
      }
      case "playlist": {
        // The playlist object itself carries the first 100 items, so the page
        // renders without a second request. Verified live 2026-08: Spotify
        // serves NEWER apps a renamed shape — the paging object is `items`
        // (not `tracks`), each row's track sits under `item` (not `track`),
        // and /playlists/{id}/tracks answers a hard 403 while
        // /playlists/{id}/items works. Accept both generations everywhere.
        // additional_types keeps podcast episodes from coming back null.
        const head = await call(
          "GET",
          `/playlists/${id}${qs({ additional_types: "track,episode" })}`
        );
        if (head.status !== 200) return fail(explain(head.status, head.json));
        const emb = head.json.tracks || head.json.items || {};
        let rows: any[] = Array.isArray(emb.items) ? emb.items : [];
        const total: number =
          typeof emb.total === "number" ? emb.total : rows.length;
        let pageError: string | null = null;
        if (emb.next) {
          const more = await paged(String(emb.next).replace(API, ""));
          rows = rows.concat(more.items);
          pageError = more.error;
        } else if (!rows.length && total !== 0) {
          // No embedded rows at all (a third shape?) — walk the items
          // endpoints directly, newest name first.
          for (const ep of ["items", "tracks"]) {
            const more = await paged(
              `/playlists/${id}/${ep}?limit=100&additional_types=track,episode`
            );
            rows = more.items;
            pageError = more.error;
            if (rows.length) break;
          }
        }
        const items = rows
          .map((r: any) => r?.track || r?.item)
          .filter((t: any) => t && t.uri)
          .map((t: any) => trackItem(t));
        if (!items.length && total > 0 && !pageError)
          pageError =
            "Spotify returned this playlist without its tracks — try reconnecting Spotify in Settings.";
        const owner = String(head.json.owner?.display_name || "");
        const count =
          items.length && items.length < total
            ? `first ${items.length} of ${total} tracks`
            : `${total} track${total === 1 ? "" : "s"}`;
        return {
          ok: true,
          kind,
          uri: String(head.json.uri || ""),
          name: String(head.json.name || "Playlist"),
          subtitle: ["Playlist", owner, count].filter(Boolean).join(" · "),
          image: imageOf(head.json.images),
          playableContext: true,
          items,
          error: pageError || undefined,
        };
      }
      case "album": {
        const head = await call("GET", `/albums/${id}`);
        if (head.status !== 200) return fail(explain(head.status, head.json));
        const rows = await paged(`/albums/${id}/tracks?limit=50`);
        return {
          ok: true,
          kind,
          uri: String(head.json.uri || ""),
          name: String(head.json.name || "Album"),
          subtitle: `Album · ${artistsOf(head.json)}`,
          image: imageOf(head.json.images),
          playableContext: true,
          items: rows.items.map((t: any) => trackItem(t, head.json.images)),
          error: rows.error || undefined,
        };
      }
      case "artist": {
        const head = await call("GET", `/artists/${id}`);
        if (head.status !== 200) return fail(explain(head.status, head.json));
        const top = await call(
          "GET",
          `/artists/${id}/top-tracks${qs({ market: profile?.country || "US" })}`
        );
        return {
          ok: true,
          kind,
          uri: String(head.json.uri || ""),
          name: String(head.json.name || "Artist"),
          subtitle: "Popular tracks",
          image: imageOf(head.json.images),
          // An artist context plays artist radio, not this list — so play
          // these individually and what you click is what you hear.
          playableContext: false,
          items: ((top.json?.tracks as any[]) || []).map((t: any) => trackItem(t)),
        };
      }
      case "show": {
        const head = await call("GET", `/shows/${id}`);
        if (head.status !== 200) return fail(explain(head.status, head.json));
        const rows = await paged(`/shows/${id}/episodes?limit=50`, 50);
        return {
          ok: true,
          kind,
          uri: String(head.json.uri || ""),
          name: String(head.json.name || "Show"),
          subtitle: `Podcast · ${head.json.publisher || ""}`.trim(),
          image: imageOf(head.json.images),
          playableContext: true,
          error: rows.error || undefined,
          items: rows.items.map((e: any) => ({
            uri: String(e.uri || ""),
            href: e.id ? webUrl("episode", e.id) : "",
            name: String(e.name || ""),
            subtitle: String(e.release_date || ""),
            image: imageOf(e.images),
            durationMs: Number(e.duration_ms) || 0,
            kind: "episode",
          })),
        };
      }
      case "episode":
      case "track": {
        const head = await call("GET", `/${kind}s/${id}`);
        if (head.status !== 200) return fail(explain(head.status, head.json));
        const one = trackItem(head.json);
        return {
          ok: true,
          kind,
          uri: one.uri,
          name: one.name,
          subtitle: one.subtitle,
          image: one.image,
          playableContext: false,
          items: [one],
        };
      }
      default:
        return fail(`Nekomitai can't open Spotify "${kind}" links yet.`);
    }
  } catch (e) {
    return fail(String(e));
  }
};
