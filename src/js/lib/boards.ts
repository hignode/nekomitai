/**
 * Reference boards: bookmarks with thumbnails, grouped into boards keyed to the
 * open After Effects project (so each .aep gets its own references). Persisted
 * server-side via the gateway /boards route.
 */
import type { GatewayInfo } from "./gateway/server";

export type BoardItem = {
  url: string;
  title: string;
  thumb?: string;
  addedAt: number;
};
export type Board = { id: string; name: string; items: BoardItem[] };
export type BoardsFile = Record<string, Board[]>;

export const GLOBAL_KEY = "__global__";

const api = (gw: GatewayInfo, path: string, init?: RequestInit) =>
  fetch(`${gw.origin}${path}${path.includes("?") ? "&" : "?"}t=${gw.token}`, init).then(
    (r) => r.json()
  );

export const loadBoards = async (gw: GatewayInfo): Promise<BoardsFile> => {
  const r = await api(gw, "/boards");
  return (r && r.boards) || {};
};

export const saveBoards = (gw: GatewayInfo, data: BoardsFile) =>
  api(gw, "/boards", { method: "POST", body: JSON.stringify(data) });

/** Best-effort thumbnail for a bookmarked URL. */
export const thumbFor = (url: string, videoId?: string): string | undefined => {
  const yt =
    videoId && /youtu/.test(url)
      ? videoId
      : (url.match(/[?&]v=([A-Za-z0-9_-]{6,})/) ||
          url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/) ||
          [])[1];
  if (yt) return `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`;
  try {
    const host = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname;
    return `https://icons.duckduckgo.com/ip3/${host}.ico`;
  } catch {
    return undefined;
  }
};

let uid = 1;
export const newId = () => `b${Date.now().toString(36)}_${uid++}`;
