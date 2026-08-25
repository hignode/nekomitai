/**
 * Settings — adblock & privacy (opt-in), Spotify Connect, and cookie logins.
 * Talks to the gateway /adblock/*, /spotify/* and /cookies routes.
 */
import { useEffect, useState } from "react";
import type { GatewayInfo } from "../../lib/gateway/server";
import { openLinkInBrowser } from "../../lib/utils/bolt";

type SpStatus = {
  configured: boolean;
  authorized: boolean;
  pending: boolean;
  premium: boolean;
  user: string | null;
  clientId: string;
  redirectUri: string;
  error: string | null;
};

type Status = {
  adblock: boolean;
  antitrack: boolean;
  blocked: number;
  listVersion: string | null;
  ready: boolean;
  loading?: boolean;
  error?: string | null;
};

export const Settings = ({ gateway }: { gateway: GatewayInfo | null }) => {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [domains, setDomains] = useState<{ domain: string; count: number }[]>([]);
  const [ckDomain, setCkDomain] = useState("");
  const [ckHeader, setCkHeader] = useState("");
  const [ckNote, setCkNote] = useState("");
  const [showGuide, setShowGuide] = useState(false);

  const api = (path: string, init?: RequestInit) =>
    fetch(`${gateway!.origin}${path}${path.includes("?") ? "&" : "?"}t=${gateway!.token}`, init).then(
      (r) => r.json()
    );

  const refresh = () => {
    if (gateway) api("/adblock/status").then(setStatus).catch(() => {});
  };

  useEffect(refresh, [gateway]);

  const toggle = async (key: "adblock" | "antitrack", value: boolean) => {
    if (!gateway) return;
    setBusy(true);
    setNote(value ? "Loading filter lists…" : "");
    try {
      // POST now awaits the engine build → response is definitive
      const s = await api("/adblock/config", {
        method: "POST",
        body: JSON.stringify({ [key]: value }),
      });
      setStatus(s);
      if (s.error) setNote(`Couldn't load lists: ${s.error}`);
      else if (value) setNote(`Filter lists ready (${s.listVersion || "loaded"})`);
      else setNote("");
    } catch (e) {
      setNote("Adblock request failed: " + String(e));
    } finally {
      setBusy(false);
    }
  };

  const updateLists = async () => {
    setBusy(true);
    setNote("Updating filter lists…");
    const s = await api("/adblock/update", { method: "POST" });
    setStatus(s);
    setBusy(false);
    setNote(s.ok === false ? "Update failed" : `Lists updated (${s.listVersion})`);
  };

  const loadDomains = () => {
    if (gateway) api("/cookies").then((r) => setDomains(r.domains || [])).catch(() => {});
  };
  useEffect(loadDomains, [gateway]);

  // ── Spotify Connect ────────────────────────────────────────────────────
  const [sp, setSp] = useState<SpStatus | null>(null);
  const [spId, setSpId] = useState("");
  const [spNote, setSpNote] = useState("");
  const [spGuide, setSpGuide] = useState(false);
  const [spWaiting, setSpWaiting] = useState(false);

  useEffect(() => {
    if (!gateway) return;
    api("/spotify/status")
      .then((s: SpStatus) => {
        setSp(s);
        setSpId((v) => v || s.clientId || "");
      })
      .catch(() => {});
  }, [gateway]);

  // While the consent screen is open in the system browser, only the gateway
  // learns how it ended (its one-shot callback server receives the redirect) —
  // so poll until it knows.
  useEffect(() => {
    if (!spWaiting || !gateway) return;
    const id = setInterval(() => {
      api("/spotify/status")
        .then((s: SpStatus) => {
          setSp(s);
          if (s.authorized || !s.pending) {
            setSpWaiting(false);
            setSpNote(
              s.authorized
                ? `Connected${s.user ? ` as ${s.user}` : ""}. Reopen any Spotify tab to switch it to the full player.`
                : s.error || "Sign-in didn't complete."
            );
          }
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(id);
  }, [spWaiting, gateway]);

  const connectSpotify = async () => {
    setSpNote("");
    const saved: SpStatus = await api("/spotify/config", {
      method: "POST",
      body: JSON.stringify({ clientId: spId.trim() }),
    });
    setSp(saved);
    if (!saved.configured) {
      setSpNote("Paste your app's Client ID first.");
      return;
    }
    const r = await api("/spotify/auth", { method: "POST" });
    if (r.status) setSp(r.status);
    if (!r.ok) {
      setSpNote(r.error || "Couldn't start the sign-in.");
      return;
    }
    // Spotify's consent screen refuses embedded webviews — and the password
    // belongs in the user's own browser anyway.
    openLinkInBrowser(r.url);
    setSpWaiting(true);
    setSpNote("Approve Nekomitai in your browser, then come back to this panel.");
  };

  const disconnectSpotify = async () => {
    const s: SpStatus = await api("/spotify/logout", { method: "POST" });
    setSp(s);
    setSpWaiting(false);
    setSpNote("Disconnected. Spotify links fall back to 30-second previews.");
  };

  const addLogin = async () => {
    if (!ckDomain.trim() || !ckHeader.trim()) {
      setCkNote("Enter a domain and the cookie string.");
      return;
    }
    const r = await api("/cookies", {
      method: "POST",
      body: JSON.stringify({
        action: "header",
        domain: ckDomain.trim(),
        header: ckHeader.trim(),
      }),
    });
    setDomains(r.domains || []);
    setCkHeader("");
    setCkNote(`Saved ${r.imported} cookie(s) for ${ckDomain.trim()} — stored locally, encrypted.`);
  };

  const removeDomain = async (domain: string) => {
    const r = await api(`/cookies?domain=${encodeURIComponent(domain)}`, {
      method: "DELETE",
    });
    setDomains(r.domains || []);
  };

  const clearCookies = async () => {
    const r = await api("/cookies", { method: "DELETE" });
    setDomains(r.domains || []);
    setNote("All site logins cleared");
  };

  if (!gateway)
    return (
      <div className="nm-placeholder">
        <h2>Settings</h2>
        <p>Waiting for the Gateway to start…</p>
      </div>
    );

  return (
    <div className="nm-settings">
      <h2>Settings</h2>

      <section>
        <h3>Adblock &amp; Privacy</h3>
        <p className="nm-hint">
          Off by default. Filtering happens in Nekomitai's proxy for pages you
          browse in Web Mode.
        </p>

        <label className="nm-switch">
          <input
            type="checkbox"
            checked={!!status?.adblock}
            disabled={busy}
            onChange={(e) => toggle("adblock", e.target.checked)}
          />
          <span>
            <strong>Block ads</strong> — EasyList network + cosmetic filtering
          </span>
        </label>

        <label className="nm-switch">
          <input
            type="checkbox"
            checked={!!status?.antitrack}
            disabled={busy}
            onChange={(e) => toggle("antitrack", e.target.checked)}
          />
          <span>
            <strong>Block trackers</strong> — EasyPrivacy tracker list
          </span>
        </label>

        <div className="nm-settings-row">
          <span className="nm-hint">
            {status?.ready
              ? `Lists: ${status.listVersion ?? "loaded"} · blocked this session: ${status.blocked}`
              : "Engine idle (enable a toggle to load lists)"}
          </span>
          <button onClick={updateLists} disabled={busy}>
            Update lists
          </button>
        </div>
        {note && <div className="nm-hint nm-note">{note}</div>}
      </section>

      <section>
        <h3>Spotify Connect</h3>
        <p className="nm-hint">
          Full tracks can't play inside the panel — that needs Widevine DRM,
          which After Effects panels have no way to run. Connect instead: the
          panel becomes a <strong>remote</strong> for the Spotify app you
          already have open, and browses your playlists in-panel.{" "}
          <strong>Spotify Premium is required</strong> to control playback.
        </p>

        {sp?.authorized ? (
          <>
            <div className="nm-settings-row">
              <span className="nm-hint">
                Connected{sp.user ? ` as ${sp.user}` : ""}
                {sp.premium ? "" : " — no Premium, so playback control is off"}
              </span>
              <button onClick={disconnectSpotify}>Disconnect</button>
            </div>
            <p className="nm-hint">
              Paste any Spotify track, album, or playlist link in the browser —
              or just <code>open.spotify.com</code> to pick from your playlists.
            </p>
          </>
        ) : (
          <>
            <div className="nm-cookie-form">
              <input
                placeholder="Spotify app Client ID (32 hex characters)"
                value={spId}
                onChange={(e) => setSpId(e.target.value)}
                spellCheck={false}
              />
              <div className="nm-settings-row">
                <button onClick={() => setSpGuide((v) => !v)}>
                  {spGuide ? "Hide" : "Where do I get a Client ID?"}
                </button>
                <button
                  className="nm-primary"
                  onClick={connectSpotify}
                  disabled={spWaiting}
                >
                  {spWaiting ? "Waiting for browser…" : "Connect Spotify"}
                </button>
              </div>
            </div>
            {spGuide && (
              <div className="nm-guide">
                <ol>
                  <li>
                    Open <code>developer.spotify.com/dashboard</code> and sign in
                    with your normal Spotify account.
                  </li>
                  <li>
                    <strong>Create app</strong> — any name and description will
                    do. Tick <strong>Web API</strong>.
                  </li>
                  <li>
                    Set <strong>Redirect URI</strong> to exactly this, then
                    Save:
                  </li>
                </ol>
                <div className="nm-cookie-form">
                  <input
                    readOnly
                    value={sp?.redirectUri || "http://127.0.0.1:45899/callback"}
                    onFocus={(e) => e.currentTarget.select()}
                    spellCheck={false}
                  />
                </div>
                <ol start={4}>
                  <li>
                    Copy the app's <strong>Client ID</strong> and paste it above.
                  </li>
                </ol>
                <p className="nm-hint">
                  Why your own ID: Spotify apps start capped at 25 hand-added
                  users, and lifting that cap needs a commercial quota review
                  Nekomitai isn't eligible for. The Client ID isn't a secret —
                  this is the PKCE flow Spotify prescribes for desktop apps, and
                  there is no client secret to store. Your tokens stay on this
                  machine, encrypted, and go nowhere but Spotify.
                </p>
              </div>
            )}
          </>
        )}
        {spNote && <div className="nm-hint nm-note">{spNote}</div>}
        {sp?.error && !spNote && (
          <div className="nm-hint nm-note">{sp.error}</div>
        )}
      </section>

      <section>
        <h3>Site logins (cookies)</h3>
        <p className="nm-hint">
          Log into Web-Mode sites (Spotify, X, Reddit, paywalled docs…) by
          pasting your browser's cookies for that site. Stored{" "}
          <strong>only on this machine, encrypted</strong>, and sent only to
          that site through Nekomitai's local proxy — never anywhere else.
        </p>

        <div className="nm-cookie-form">
          <input
            placeholder="Domain (e.g. open.spotify.com)"
            value={ckDomain}
            onChange={(e) => setCkDomain(e.target.value)}
            spellCheck={false}
          />
          <textarea
            placeholder="Paste the cookie string:  name1=value1; name2=value2; …"
            value={ckHeader}
            onChange={(e) => setCkHeader(e.target.value)}
            spellCheck={false}
            rows={3}
          />
          <div className="nm-settings-row">
            <button onClick={() => setShowGuide((s) => !s)}>
              {showGuide ? "Hide" : "How do I get my cookies?"}
            </button>
            <button className="nm-primary" onClick={addLogin}>
              Add login
            </button>
          </div>
          {ckNote && <div className="nm-hint nm-note">{ckNote}</div>}
        </div>

        {showGuide && (
          <div className="nm-guide">
            <ol>
              <li>
                In your normal browser (Chrome/Edge/Firefox), log in to the site
                — e.g. <code>open.spotify.com</code>.
              </li>
              <li>
                Press <code>F12</code> to open DevTools →{" "}
                <strong>Application</strong> tab (Firefox: <strong>Storage</strong>).
              </li>
              <li>
                Left panel → <strong>Cookies</strong> → click the site's origin.
              </li>
              <li>
                Easiest full copy: open the <strong>Network</strong> tab, reload
                the page, click the first request, find{" "}
                <strong>Request Headers → Cookie</strong>, and copy that whole
                line.
              </li>
              <li>
                Paste it above with the domain, and click <strong>Add login</strong>.
              </li>
            </ol>
            <p className="nm-hint">
              Reality check: this makes the site load <em>logged in</em> in Web
              Mode. <strong>Spotify is the exception</strong> — its site never
              renders through the proxy at all, and cookies can't buy full
              tracks either, because that needs Widevine DRM After Effects
              panels can't run. Use <strong>Spotify Connect</strong> above
              instead: it drives your real Spotify app, which can. Cookie login{" "}
              <em>does</em> give full logged-in browsing for most other sites.
            </p>
            <p className="nm-hint">
              ⚠ Cookies are like passwords. Only paste your own, on your own
              machine. Remove them here when you're done.
            </p>
          </div>
        )}

        {domains.length > 0 && (
          <div className="nm-domains">
            <div className="nm-hint">Saved logins:</div>
            {domains.map((d) => (
              <div key={d.domain} className="nm-domain-row">
                <span>
                  {d.domain} <span className="nm-hint">({d.count})</span>
                </span>
                <button onClick={() => removeDomain(d.domain)}>Remove</button>
              </div>
            ))}
            <button className="nm-clear-all" onClick={clearCookies}>
              Clear all site logins
            </button>
          </div>
        )}
      </section>

      <section>
        <h3>About filtering</h3>
        <p className="nm-hint">
          Powered by @ghostery/adblocker (MPL-2.0) with EasyList &amp;
          EasyPrivacy (CC BY-SA 3.0, © The EasyList authors). Ad blocking is
          your choice and is disabled unless you turn it on.
        </p>
      </section>
    </div>
  );
};
