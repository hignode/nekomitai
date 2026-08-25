<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="banner_icon.png">
    <img src="banner_icon_dark.png" alt="NekoMitai" width="520">
  </picture>

**Browse the web, watch reference videos, and pull colors & assets straight into your comp — without leaving After Effects.**

A CEP 12 panel extension for Adobe After Effects 2025/2026, with an optional built-in adblocker & anti-tracker.

</div>

## Features

- **Video Mode** — paste a YouTube / Vimeo / Twitch / Dailymotion / SoundCloud link and it plays in-panel through the provider's official embed player
- **Media player** — direct video/image/audio URLs open in Nekomitai's own player
- **Web Mode** — browse arbitrary sites through a local header-stripping Gateway proxy; best-effort by design (heavy SPAs, service workers, and DRM won't work)
- **Send to AE** — import the page's media into a project bin, or straight into the active comp
- **Color grab** — eyedropper any pixel on screen into a solid in your project
- **Timestamp markers** — drop comp markers carrying the video URL + timecode
- **Auto-duck** — while AE is actually previewing (not scrubbing), every tab's audio ducks: music pauses, everything else mutes, and it all comes back when the preview stops
- **Spotify Connect** — sign in with your own (free) Spotify app via OAuth PKCE and Spotify links become a full remote-control player for whatever Spotify device you're running — see [docs/SPOTIFY-CONNECT.md](docs/SPOTIFY-CONNECT.md)
- **Login with cookies** — paste your own cookies to use logged-in sites in Web Mode — see [docs/LOGIN-WITH-COOKIES.md](docs/LOGIN-WITH-COOKIES.md)
- **Adblock & anti-tracker** (opt-in, **off by default**) — powered by [@ghostery/adblocker](https://github.com/ghostery/adblocker) (MPL-2.0) over EasyList + EasyPrivacy
- **Reference boards** per project, tab/session restore, and a UI that matches your AE theme

## Requirements

- After Effects **2025 (25.0) or newer** (CEP 12)
- Windows fully supported. On macOS everything works except preview detection by *audio* — ducking there relies on the script-heartbeat signal only.

## Install

1. Download the latest `com.izunatext.nekomitai.zxp` from the
   [Releases](https://github.com/hignode/nekomitai/releases) page.
2. Install it with a ZXP installer — the free
   [aescripts ZXP/UXP Installer](https://aescripts.com/learn/post/zxp-installer)
   or [Anastasiy's Extension Manager](https://install.anastasiy.com/).
3. Restart After Effects → **Window → Extensions → Nekomitai**.

> The ZXP is self-signed. If your installer warns about the signature, that's
> expected — or build from source below and judge the code yourself.

## Using it

- **Browse** — type or paste a URL. Nekomitai picks the right mode automatically: known video/music sites get their official player, direct media files get the built-in player, everything else goes through Web Mode.
- Use the toolbar on a media page to **import to bin**, **import into the active comp**, **grab a color**, or **drop a timecode marker**.
- **Settings** — turn on the ad blocker, set up Spotify Connect, or paste cookies for logged-in browsing.
- **Diagnostics** — if something misbehaves, this screen probes every subsystem (codecs, ExtendScript bridge, Gateway, proxy, adblock, import round-trip) and tells you what's broken.

## Privacy & security

- Everything runs **locally**. There is no server, no account, and no telemetry.
- The internal Gateway binds to `127.0.0.1` only, and every request requires a per-session token.
- Cookies and Spotify tokens are encrypted at rest (AES-256-GCM) under your user profile (`%APPDATA%\Nekomitai`), and cookies are only ever sent back to the site they came from.
- Spotify sign-in uses Authorization Code + PKCE with **your own** Client ID; there is no client secret anywhere.
- Known limitation: CEP's bundled Node has no CA certificate store, so the Gateway's outbound HTTPS does not verify server certificates. Treat Web Mode like an untrusted preview, not a banking browser.

## Develop

```bash
git clone https://github.com/hignode/nekomitai.git
cd nekomitai
npm install        # .npmrc already sets legacy-peer-deps
npm run build      # typecheck + build into dist/cep
npm run symlink    # once per machine: link dist/cep into the CEP extensions folder
npm run dev        # hot-reload dev server on :3000
```

Enable unsigned panels once per machine (Windows): set
`HKEY_CURRENT_USER\Software\Adobe\CSXS.12` → `PlayerDebugMode` = `1` (macOS:
`defaults write com.adobe.CSXS.12 PlayerDebugMode 1`), then restart AE. The
panel appears under **Window → Extensions → Nekomitai**, and DevTools attach at
`localhost:8860`.

There is no test runner; `npx tsc -p tsconfig-build.json` is the automated
check, and the panel's **Diagnostics** screen is the manual one.
`docs/blueprint.html` is the full design doc.

## Package a signed ZXP

Signing needs Adobe's `ZXPSignCmd` on the `PATH`:

```bash
# one-time: fetch the tool (Windows x64)
curl -L -o tools/ZXPSignCmd.exe \
  https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.3/x64/ZXPSignCmd.exe

PATH="$PWD/tools:$PATH" npm run zxp   # → dist/zxp/com.izunatext.nekomitai.zxp
```

The certificate is self-signed and generated fresh on every run; set
`ZXP_CERT_PASSWORD` to use your own password. Pushing a `x.y.z` git tag runs
the GitHub Actions workflow, which builds the ZXP and attaches it to a GitHub
Release automatically.

## Made by

**Akamine Izuna** — [X @Izuna_text](https://x.com/Izuna_text)

Support us! ☕ [buymeacoffee.com/izunatext](https://buymeacoffee.com/izunatext)

## License

Nekomitai is **MIT licensed** — see [LICENSE](LICENSE). It's built on the
[Bolt CEP](https://github.com/hyperbrew/bolt-cep) scaffold (MIT). Third-party
components keep their own licenses (see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)): @ghostery/adblocker is
MPL-2.0; the optional blocker fetches EasyList/EasyPrivacy at runtime, used
under CC BY-SA 3.0 with attribution to The EasyList authors
([easylist.to](https://easylist.to/)).
