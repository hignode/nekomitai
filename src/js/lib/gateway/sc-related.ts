/**
 * SoundCloud lookups for the view page's own overlays — the end screen after a
 * track finishes, and the queue for a set (playlist).
 *
 * Both exist because the official widget's own affordances are dead inside
 * CEP. Its "Play more tracks like…" tiles are target="_blank" links (the
 * widget HTML carries <base target="_blank">) and popups never open in a CEP
 * panel; its playlist sidebar is reachable but cramped in the visual layout we
 * use, and its API exposes no click event to react to either way. So the view
 * page renders its OWN overlays, fed by this module: the same
 * api-widget.soundcloud.com endpoints the widget itself calls, fetched
 * server-side where browser CORS doesn't apply.
 *
 * The public client_id rotates with widget releases, so a pinned fallback list
 * is re-scraped from the live widget JS when it stops working.
 */
import { fetchTarget } from "./proxy";

export type ScTrack = {
  url: string;
  title: string;
  artist: string;
  artwork: string;
  durationMs: number;
};

const API = "https://api-widget.soundcloud.com";
// extracted 2026-08 from widget-9-*.js (`client_id:a?"…":"…"` — anonymous arm)
const FALLBACK_IDS = [
  "gqKBMSuBw5rbN9rDRYPqKNvF17ovlObu",
  "nIjtjiYnjkOhMyh5xrbqEW12DxeJVnic",
];

let clientId: string | null = null;

const getText = (url: string): Promise<{ status: number; body: string }> =>
  fetchTarget(url).then((r) => ({ status: r.status, body: r.body.toString("utf8") }));

const resolveWith = (
  targetUrl: string,
  id: string
): Promise<{ status: number; data: any }> =>
  getText(
    `${API}/resolve?url=${encodeURIComponent(targetUrl)}&format=json&client_id=${id}`
  ).then((r) => {
    let data: any = null;
    if (r.status === 200) {
      try {
        data = JSON.parse(r.body);
      } catch {
        /* ignore */
      }
    }
    return { status: r.status, data };
  });

/** Pull current client_id candidates out of the live widget bundle. */
const scrapeClientIds = async (): Promise<string[]> => {
  const page = await getText(
    "https://w.soundcloud.com/player/?url=" +
      encodeURIComponent("https://soundcloud.com/forss/flickermood")
  );
  const srcs = Array.from(
    page.body.matchAll(/https:\/\/widget\.sndcdn\.com\/widget-[\w.-]+\.js/g)
  ).map((m) => m[0]);
  // config (with client_id) lives in the biggest bundle — scan last-to-first
  for (const src of Array.from(new Set(srcs)).reverse()) {
    try {
      const js = await getText(src);
      const at = js.body.indexOf("client_id");
      if (at < 0) continue;
      const near = js.body.slice(at, at + 200);
      const ids = Array.from(near.matchAll(/"([A-Za-z0-9]{28,40})"/g)).map(
        (m) => m[1]
      );
      if (ids.length) return ids;
    } catch {
      /* try next bundle */
    }
  }
  return [];
};

/** Resolve any soundcloud.com URL (track or set), finding a working client_id
 * along the way: cached → pinned fallbacks → live scrape. */
const resolveAny = async (targetUrl: string): Promise<any | null> => {
  const tried = new Set<string>();
  const candidates = clientId ? [clientId, ...FALLBACK_IDS] : FALLBACK_IDS;
  for (const id of candidates) {
    if (tried.has(id)) continue;
    tried.add(id);
    const r = await resolveWith(targetUrl, id);
    if (r.data) {
      clientId = id;
      return r.data;
    }
  }
  for (const id of await scrapeClientIds()) {
    if (tried.has(id)) continue;
    tried.add(id);
    const r = await resolveWith(targetUrl, id);
    if (r.data) {
      clientId = id;
      return r.data;
    }
  }
  return null;
};

/** SoundCloud's default artwork is 100×100; the tiles want something better. */
const art = (t: any): string => {
  const raw = String(t?.artwork_url || t?.user?.avatar_url || "");
  return raw.replace(/-large(\.\w+)$/, "-t200x200$1");
};

const toTrack = (t: any): ScTrack => ({
  url: String(t.permalink_url || ""),
  title: String(t.title || ""),
  artist: String((t.user && t.user.username) || ""),
  artwork: art(t),
  durationMs: Number(t.duration) || 0,
});

export const scRelated = async (
  trackUrl: string
): Promise<{ ok: boolean; tracks: ScTrack[]; error?: string }> => {
  try {
    const data = await resolveAny(trackUrl);
    if (!data) return { ok: false, tracks: [], error: "SoundCloud API unavailable" };

    // A set finishes on its LAST track, so that is what "more like this"
    // should be seeded from — using the set itself has no related endpoint.
    let seedId: number | null = null;
    if (data.kind === "track" && data.id) seedId = Number(data.id);
    else if (data.kind === "playlist" && Array.isArray(data.tracks) && data.tracks.length)
      seedId = Number(data.tracks[data.tracks.length - 1]?.id) || null;
    if (!seedId) return { ok: true, tracks: [] };

    const rel = await getText(
      `${API}/tracks/${seedId}/related?client_id=${clientId}&limit=12`
    );
    if (rel.status !== 200)
      return { ok: false, tracks: [], error: `related lookup HTTP ${rel.status}` };
    const collection: any[] = JSON.parse(rel.body).collection || [];
    return {
      ok: true,
      tracks: collection.filter((t) => t && t.permalink_url).map(toTrack),
    };
  } catch (e) {
    return { ok: false, tracks: [], error: String(e) };
  }
};

/**
 * A set's track list, in widget order — so the view page's queue overlay can
 * highlight the current track and skip straight to any other one. Answers
 * `kind: "track"` for single tracks; the caller just doesn't show a queue.
 */
export const scPlaylist = async (
  url: string
): Promise<{
  ok: boolean;
  kind: string;
  title: string;
  tracks: ScTrack[];
  error?: string;
}> => {
  try {
    const data = await resolveAny(url);
    if (!data)
      return {
        ok: false,
        kind: "",
        title: "",
        tracks: [],
        error: "SoundCloud API unavailable",
      };
    if (data.kind !== "playlist")
      return { ok: true, kind: String(data.kind || "track"), title: "", tracks: [] };

    // /resolve returns playlist tracks partially hydrated — entries past the
    // first few carry only an id. Backfill them in one batch so the queue
    // isn't a list of blanks.
    const raw: any[] = Array.isArray(data.tracks) ? data.tracks : [];
    const thin = raw.filter((t) => t && t.id && !t.title).map((t) => t.id);
    const filled = new Map<number, any>();
    for (let i = 0; i < thin.length; i += 50) {
      const ids = thin.slice(i, i + 50).join(",");
      const r = await getText(
        `${API}/tracks?ids=${encodeURIComponent(ids)}&client_id=${clientId}`
      );
      if (r.status !== 200) break;
      try {
        for (const t of JSON.parse(r.body) || []) filled.set(Number(t.id), t);
      } catch {
        break;
      }
    }

    return {
      ok: true,
      kind: "playlist",
      title: String(data.title || ""),
      tracks: raw
        .map((t) => (t && t.title ? t : filled.get(Number(t?.id)) || t))
        .filter((t) => t && t.title)
        .map(toTrack),
    };
  } catch (e) {
    return { ok: false, kind: "", title: "", tracks: [], error: String(e) };
  }
};
