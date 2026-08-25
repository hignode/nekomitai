/**
 * Watch-URL → embeddable-player-URL resolution.
 * Pure functions, no network needed for the major providers (oEmbed lookup
 * arrives with M2 for long-tail providers).
 */
import { isSpotifyAuthorized } from "./spotify";

export type EmbedResolution =
  | {
      kind: "embed";
      provider: string;
      embedUrl: string;
      videoId: string;
      /** Spotify only: drive the user's own Spotify app over Connect instead
       * of framing the preview-only embed. */
      connect?: boolean;
      /** Spotify only: track | album | playlist | episode | show | artist |
       * library (the synthetic "your playlists" context). */
      spKind?: string;
    }
  | { kind: "media"; url: string } // direct media file → our own <video>/<img> player
  | { kind: "web"; url: string }; // not a video → Web Mode (proxy tier)

const YT_PATTERNS = [
  /(?:youtube\.com|youtube-nocookie\.com)\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)([A-Za-z0-9_-]{6,})/,
  /youtu\.be\/([A-Za-z0-9_-]{6,})/,
];

const MEDIA_EXT =
  /\.(mp4|webm|m4v|mov|ogv|mp3|wav|ogg|aac|flac|gif|png|jpe?g|webp|avif|svg)(\?.*)?$/i;

export const resolveEmbed = (raw: string): EmbedResolution => {
  // spotify:track:… URIs → the https page, then the Spotify rules below
  const su = raw
    .trim()
    .match(/^spotify:(track|album|playlist|episode|show|artist):([A-Za-z0-9]+)$/);
  const url = su
    ? `https://open.spotify.com/${su[1]}/${su[2]}`
    : normalizeUrl(raw);

  for (const p of YT_PATTERNS) {
    const m = url.match(p);
    if (m)
      return {
        kind: "embed",
        provider: "youtube",
        videoId: m[1],
        // enablejsapi=1 lets our view page drive playback via postMessage
        embedUrl: `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=1&rel=0&modestbranding=1&enablejsapi=1&playsinline=1`,
      };
  }

  let m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (m)
    return {
      kind: "embed",
      provider: "vimeo",
      videoId: m[1],
      embedUrl: `https://player.vimeo.com/video/${m[1]}?autoplay=1`,
    };

  // Twitch's player CSP is frame-ancestors=localhost checked against EVERY
  // ancestor, which a file:// panel can't satisfy → route the full site through
  // Web Mode so it always loads in-panel (video is best-effort).
  if (/^https?:\/\/([\w-]+\.)*twitch\.tv\//i.test(url)) return { kind: "web", url };

  m =
    url.match(/dailymotion\.com\/video\/([A-Za-z0-9]+)/) ||
    url.match(/dai\.ly\/([A-Za-z0-9]+)/);
  if (m)
    return {
      kind: "embed",
      provider: "dailymotion",
      videoId: m[1],
      embedUrl: `https://geo.dailymotion.com/player.html?video=${m[1]}`,
    };

  // Spotify: the real open.spotify.com never survives the proxy — it is a hard
  // SPA that boots behind a service worker and its own CSP, so Web Mode only
  // ever renders its "Something went wrong" card.
  //
  // Which player a link gets depends on whether Spotify Connect is hooked up:
  //  - connected → our own Connect page, which remote-controls the user's
  //    real Spotify app. Full tracks, real playlists, because the audio is
  //    coming out of a client that HAS a Widevine CDM.
  //  - not connected → the official embed, which is at least built to be
  //    framed, and plays the 30s preview. Full tracks there would need
  //    Widevine, which CEP has no way to run at all.
  // With Connect on, even the bare domain becomes useful: it resolves to the
  // user's playlist library instead of a page that cannot render.
  m = url.match(
    /^https?:\/\/open\.spotify\.com\/(?:intl-[\w-]+\/)?(?:embed\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/i
  );
  if (m) {
    const kind = m[1].toLowerCase();
    return {
      kind: "embed",
      provider: "spotify",
      videoId: m[2],
      connect: isSpotifyAuthorized(),
      spKind: kind,
      embedUrl: `https://open.spotify.com/embed/${kind}/${m[2]}?utm_source=generator`,
    };
  }
  if (/^https?:\/\/open\.spotify\.com\//i.test(url)) {
    if (isSpotifyAuthorized())
      return {
        kind: "embed",
        provider: "spotify",
        videoId: "",
        connect: true,
        spKind: "library",
        embedUrl: "",
      };
    return { kind: "web", url };
  }

  // SoundCloud widget — full playback of public tracks, no login needed
  m = url.match(
    /https?:\/\/(?:www\.|m\.)?(soundcloud\.com\/[\w-]+(?:\/(?:sets\/)?[\w-]+)*(?:\?[^#]*)?|on\.soundcloud\.com\/[A-Za-z0-9]+)/
  );
  if (m)
    return {
      kind: "embed",
      provider: "soundcloud",
      videoId: m[1],
      embedUrl: `https://w.soundcloud.com/player/?url=${encodeURIComponent(
        "https://" + m[1]
      )}&auto_play=true&visual=true&show_teaser=false`,
    };

  if (MEDIA_EXT.test(url)) return { kind: "media", url };

  return { kind: "web", url };
};

export const normalizeUrl = (raw: string): string => {
  const s = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (s.startsWith("file:")) return s;
  // bare domain or path → assume https
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(s)) return "https://" + s;
  // not URL-shaped → treat as a web search
  return "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(s);
};
