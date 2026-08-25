# Spotify Connect

## Why this exists

Full-length Spotify playback **cannot** happen inside the Nekomitai panel, and
no amount of clever proxying changes that:

- `open.spotify.com` is a service-worker SPA behind its own CSP. It never
  survives the Web-Mode proxy — you get its "Something went wrong" card.
- The official embed *is* built to be framed, but plays **30-second previews**
  for anonymous listeners. Full tracks there go through Widevine DRM.
- CEP 12 gives us Chromium 99 with **no Widevine CDM**. There is no flag, no
  cookie, and no login that adds one.

Cookie login (see [LOGIN-WITH-COOKIES.md](LOGIN-WITH-COOKIES.md)) does not help
here for the same reason — a logged-in embed still needs a CDM we do not have.

So Nekomitai does the thing that *is* supported: it becomes a **remote**. The
Spotify Web API drives whatever Spotify client you already have running — the
desktop app, your phone, a speaker — and the audio comes out of there. The
panel shows now-playing, a real tracklist, transport, and a device picker.

Because the audio is not in the panel, auto-duck still works exactly as it does
for other music: while you preview in After Effects, Nekomitai **pauses**
Spotify and resumes it afterwards.

## Requirements

| | |
|---|---|
| **Spotify Premium** | Required for play/pause/seek/skip. Free accounts can still browse playlists in-panel. |
| **A Spotify client running** | Something has to be the speaker. If nothing is active, Nekomitai picks a device and hands playback to it on the first command. |
| **Your own Client ID** | See below. |

### Why you supply the Client ID

Spotify apps start in development mode, capped at 25 users the developer adds
by hand. Lifting that cap needs an extended-quota review that a locally
installed panel is not eligible for. So each user registers their own free app.

There is nothing secret to protect: this is the **Authorization Code with
PKCE** flow that Spotify prescribes for desktop apps, and it has no client
secret at all.

## Setup

1. Open <https://developer.spotify.com/dashboard> and sign in with your normal
   Spotify account.
2. **Create app** — any name/description. Tick **Web API**.
3. Set the **Redirect URI** to exactly:

   ```
   http://127.0.0.1:45899/callback
   ```

   It must match character for character, and it must be `127.0.0.1` — Spotify
   stopped accepting `http://localhost` redirect URIs, but still allows literal
   loopback addresses over plain HTTP.
4. Copy the **Client ID** into Nekomitai → **Settings → Spotify Connect**, and
   click **Connect Spotify**.
5. Your browser opens Spotify's consent screen. Approve, then return to the
   panel — it is polling for the result and will say "Connected as …".

Already-open Spotify tabs keep whatever player they were created with. Reopen
them to pick up the Connect player.

## What each link does once connected

| Link | Result |
|---|---|
| `/track/…`, `/episode/…` | Plays it; the panel shows now-playing and transport. |
| `/playlist/…`, `/album/…` | Full tracklist. Click any row to start there — the rest stays queued behind it, because playback starts *within* the context. |
| `/artist/…` | Popular tracks, played individually (an artist context plays artist radio, which is not what the list shows). |
| `/show/…` | Episode list. |
| `open.spotify.com` (bare) | **Your playlists.** Without Connect this URL has no working player at all. |
| `spotify:track:…` URIs | Normalized to the https link first, then as above. |

Without Connect configured, every one of these falls back to the preview embed,
and the view page says so in a banner instead of letting the 30-second cutoff
look like a bug.

## Where things live

- [src/js/lib/gateway/spotify.ts](../src/js/lib/gateway/spotify.ts) — PKCE flow,
  token store, Web API calls, playback snapshot, context resolution.
- [src/js/lib/gateway/vault.ts](../src/js/lib/gateway/vault.ts) — AES-256-GCM at
  rest, shared with the cookie jar.
- [src/js/lib/gateway/view-page.ts](../src/js/lib/gateway/view-page.ts) — the
  Connect surface (`spotifyPage`).
- Gateway routes: `/spotify/status`, `/spotify/config`, `/spotify/auth`,
  `/spotify/logout`, `/spotify/state`, `/spotify/cmd`, `/spotify/context`.

### Security notes

- The OAuth callback is **not** served by the Gateway. The Gateway's port
  floats (it hunts upward from 45789 when a port is taken), so a redirect URI
  registered once would eventually stop matching. Instead a one-shot server
  binds the fixed port 45899 for the seconds the flow is open, answers exactly
  one path, verifies `state`, and closes itself — with a 5-minute hard timeout.
  It also keeps the token-bearing redirect off the surface that serves hostile
  web content.
- Access and refresh tokens live in `%APPDATA%\Nekomitai\spotify.vault`,
  encrypted with a key in `.token-key` beside it. Same caveat as the cookie
  vault: this protects against the folder being copied or cloud-synced, not
  against someone already inside your user account.
- Scopes are read-heavy and write-nothing-but-playback:
  `user-read-playback-state`, `user-modify-playback-state`,
  `user-read-currently-playing`, `playlist-read-private`,
  `playlist-read-collaborative`, `user-library-read`. Nekomitai never modifies
  your playlists, follows, or saved tracks.
- **Disconnect** in Settings deletes the vault. Revoking Nekomitai's access
  entirely is done at <https://www.spotify.com/account/apps/>.

## Troubleshooting

**"INVALID_CLIENT: Invalid redirect URI"** — the URI in the dashboard doesn't
match `http://127.0.0.1:45899/callback` exactly. Watch for a trailing slash or
`localhost`.

**"Port 45899 is busy"** — something else holds the port; the sign-in redirect
can't be received. Close it and connect again.

**"No Spotify device is active"** — open Spotify somewhere and press play once,
then retry. Nekomitai will auto-target a device after that.

**"Spotify Premium is required"** — the Web API refuses transport control for
free accounts. Browsing still works.

**Nothing happens after approving in the browser** — the panel polls for 5
minutes, then gives up. Check Diagnostics → *Spotify Connect* for the exact
state.
