# Third-Party Notices

Nekomitai includes and uses the following third-party components. Their
licenses are reproduced or linked below; Nekomitai's own code is separate from
these and does not relicense them.

## @ghostery/adblocker

- License: **MPL-2.0** (Mozilla Public License 2.0)
- Source: https://github.com/ghostery/adblocker
- Used unmodified as the ad-blocking / anti-tracking engine (network matching
  and cosmetic filtering).
- MPL-2.0 is file-level copyleft: the covered files remain under MPL-2.0, may be
  combined with other-licensed code in a larger work, and their source is
  available at the URL above. Full license text: https://www.mozilla.org/MPL/2.0/

## Bolt CEP

- License: **MIT**
- Source: https://github.com/hyperbrew/bolt-cep
- Project scaffold / build tooling.

## Filter lists (downloaded at runtime, not bundled)

Nekomitai's optional ad blocker downloads the following lists at runtime only
when the user enables blocking. They are used under their own licenses with
attribution:

### EasyList & EasyPrivacy

- License: **GNU GPLv3 / Creative Commons BY-SA 3.0** (dual-licensed; used here
  under CC BY-SA 3.0)
- Attribution: **The EasyList authors** — https://easylist.to/
- Not modified; fetched from https://easylist.to/ and used as-is.

### Deliberately NOT included

To keep the project commercial-friendly, Nekomitai does **not** bundle or fetch:

- **Peter Lowe's list** (non-commercial "McRae GPL") — this is why the prebuilt
  Ghostery engine bundle is not used; the engine is built from EasyList /
  EasyPrivacy only.
- **uBlock Origin code** (GPL-3.0) — only its filter syntax (parsed by the
  Ghostery engine) is relied upon, not its code.
- **DuckDuckGo Tracker Radar / Ghostery TrackerDB** (CC BY-NC-SA, non-commercial).
