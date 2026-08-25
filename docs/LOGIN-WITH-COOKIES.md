# Logging in to sites with cookies

Nekomitai can browse **Web-Mode** sites as your logged-in self by importing the
cookies from a browser where you're already signed in. This is useful for X /
Twitter, Reddit, news paywalls, private docs, SoundCloud likes, and Spotify's
library/playlists.

> **Read this about Spotify first.** Cookies let Spotify's site load *logged in*,
> so you can see your library and playlists — but **music still won't play**.
> Full-track audio uses Widevine DRM, which After Effects panels cannot run.
> To actually hear audio, use the upcoming **Spotify Connect** feature (it
> controls playback in your Spotify desktop app). Cookies give full logged-in
> browsing for most *other* sites.

## Where the cookies go (privacy)

- Stored **only on your machine**, encrypted at rest (AES-256-GCM) with a random
  key kept in a separate local keyfile under
  `%APPDATA%\Nekomitai\` (Windows) / `~/Library/Application Support/Nekomitai/`.
- Sent **only** to the site they belong to, and only through Nekomitai's local
  proxy on `127.0.0.1`. There is no Nekomitai server, no analytics — nothing
  leaves your computer.
- At-rest encryption protects against the folder being copied or cloud-synced.
  It is **not** protection against someone who already has full access to your
  user account. Treat these like passwords: only paste your own, and remove them
  when you're done (Settings → Site logins → Remove / Clear all).

## How to get your cookie string

1. In your normal browser (Chrome, Edge, or Firefox), **log in** to the site,
   e.g. `https://open.spotify.com`.
2. Press **F12** to open DevTools.
3. Open the **Network** tab and **reload** the page.
4. Click the **first request** in the list (usually the page itself).
5. Scroll to **Request Headers** and find the **`Cookie:`** line.
6. Copy the entire value after `Cookie:` — it looks like
   `sp_dc=AbC...; sp_key=...; sp_t=...` (many `name=value` pairs separated by
   `; `).

> Alternative: DevTools → **Application** tab (Firefox: **Storage**) →
> **Cookies** → the site's origin shows every cookie individually. The Network
> method above is faster because it copies them all at once.

## Add it to Nekomitai

1. Open the **Settings** tab in the Nekomitai panel.
2. Under **Site logins (cookies)**:
   - **Domain**: the site host, e.g. `open.spotify.com`
   - **Cookie string**: paste what you copied
3. Click **Add login**. Reload the site in the Browse tab — it should now be
   logged in.

## Per-site notes

| Site | Domain to use | What works with cookies |
|------|---------------|-------------------------|
| Spotify | `open.spotify.com` | Library, playlists, browse (no audio — DRM) |
| X / Twitter | `x.com` | Full logged-in browsing |
| Reddit | `www.reddit.com` | Logged-in feeds, saved posts |
| SoundCloud | `soundcloud.com` | Likes, playlists (public tracks play regardless) |
| News paywalls | the article's host | Subscriber access |

> Cookie login applies to **Web Mode** (proxied) sites. Video players that load
> as official embeds (YouTube, Vimeo, Twitch, the SoundCloud widget) use After
> Effects' own browser cookie store instead and aren't affected by this.

## Cookies expiring

Sites rotate cookies; a login may stop working after days or weeks. Just repeat
the steps to refresh it. Use **Clear all site logins** to wipe everything.
