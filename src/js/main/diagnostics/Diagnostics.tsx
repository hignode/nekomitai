/**
 * M0 spike validation screen. Runs the platform checks the build plan depends
 * on and produces a copyable report. Auto checks run on mount; embed playback
 * checks need human eyes (cross-origin iframes can't be introspected).
 */
import { useEffect, useState } from "react";
import { csi, evalTS } from "../../lib/utils/bolt";
import { buffer, fs, os, path } from "../../lib/cep/node";
import type { GatewayInfo } from "../../lib/gateway/server";

type Status = "pending" | "pass" | "fail" | "manual" | "info";
type Result = { label: string; status: Status; detail: string };
type Results = Record<string, Result>;

const YT_TEST_ID = "aqz-KE-bpKQ"; // Big Buck Bunny (Blender Foundation, CC-BY)

export const Diagnostics = ({ gateway }: { gateway: GatewayInfo | null }) => {
  const [results, setResults] = useState<Results>({});
  const [ytVisible, setYtVisible] = useState(false);
  const [twVisible, setTwVisible] = useState(false);
  const [webVisible, setWebVisible] = useState(false);

  const set = (key: string, r: Result) =>
    setResults((prev) => ({ ...prev, [key]: r }));

  useEffect(() => {
    // — environment —
    const chrome = navigator.userAgent.match(/Chrome\/([\d.]+)/);
    set("chromium", {
      label: "Embedded Chromium",
      status: chrome ? "info" : "fail",
      detail: chrome ? `v${chrome[1]}` : "not detected",
    });

    if (window.cep) {
      set("node", {
        label: "Node.js runtime",
        status: "info",
        detail: `v${process.versions.node}`,
      });
      try {
        const api = csi.getCurrentApiVersion();
        const env = JSON.parse(window.__adobe_cep__.getHostEnvironment());
        set("cep", {
          label: "CEP / host app",
          status: "info",
          detail: `CSXS API ${api.major}.${api.minor} · ${env.appName} ${env.appVersion}`,
        });
      } catch (e) {
        set("cep", { label: "CEP / host app", status: "fail", detail: String(e) });
      }
    } else {
      set("node", {
        label: "Node.js runtime",
        status: "fail",
        detail: "window.cep missing — not inside CEP",
      });
    }

    // — codecs (decides which sites can play video) —
    const v = document.createElement("video");
    const h264 = v.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
    set("h264", {
      label: "H.264/AAC playback",
      status: h264 ? "pass" : "fail",
      detail: h264 || "no",
    });
    const mse = typeof MediaSource !== "undefined";
    set("vp9", {
      label: "VP9 via MSE (YouTube)",
      status: mse && MediaSource.isTypeSupported('video/webm; codecs="vp9"') ? "pass" : "fail",
      detail: mse ? "" : "MediaSource missing",
    });
    set("av1", {
      label: "AV1 via MSE (optional)",
      status: mse && MediaSource.isTypeSupported('video/mp4; codecs="av01.0.05M.08"') ? "pass" : "info",
      detail: "not required — YouTube falls back to VP9/H.264",
    });

    // — EyeDropper API (color-grab feature) —
    set("eyedropper", {
      label: "EyeDropper API present",
      status: "EyeDropper" in window ? "pass" : "fail",
      detail: "EyeDropper" in window ? "" : "feature needs fallback design",
    });

    // — ExtendScript bridge —
    if (window.cep) {
      evalTS("ping").then(
        (res: any) =>
          set("jsx", {
            label: "ExtendScript bridge (ping)",
            status: res && res.ok ? "pass" : "fail",
            detail: res && res.ok ? `AE ${res.appVersion}` : JSON.stringify(res),
          }),
        (e) =>
          set("jsx", {
            label: "ExtendScript bridge (ping)",
            status: "fail",
            detail: String(e && e.message ? e.message : e),
          })
      );
    }
  }, []);

  // — gateway (own effect: waits for it to come up) —
  useEffect(() => {
    if (!gateway) return;
    fetch(`${gateway.origin}/health?t=${gateway.token}`)
      .then((r) => r.json())
      .then((j) =>
        set("gateway", {
          label: "Gateway server",
          status: j.ok ? "pass" : "fail",
          detail: `${gateway.origin} · v${j.version}`,
        })
      )
      .catch((e) =>
        set("gateway", { label: "Gateway server", status: "fail", detail: String(e) })
      );

    // Spotify Connect — the only path to full tracks, so report exactly which
    // of its three preconditions is missing (app, sign-in, Premium, device).
    fetch(`${gateway.origin}/spotify/status?t=${gateway.token}`)
      .then((r) => r.json())
      .then((s) => {
        if (!s.configured)
          return set("spotify", {
            label: "Spotify Connect",
            status: "info",
            detail: "not set up — add a Client ID in Settings (previews only)",
          });
        if (!s.authorized)
          return set("spotify", {
            label: "Spotify Connect",
            status: "info",
            detail: s.error || "client ID saved, not signed in yet",
          });
        return fetch(`${gateway.origin}/spotify/state?t=${gateway.token}`)
          .then((r) => r.json())
          .then((p) =>
            set("spotify", {
              label: "Spotify Connect",
              status: p.premium ? "pass" : "fail",
              detail: `${s.user || "signed in"} · ${
                p.premium ? "Premium" : "no Premium — playback control unavailable"
              } · ${p.devices?.length || 0} device(s)`,
            })
          );
      })
      .catch((e) =>
        set("spotify", { label: "Spotify Connect", status: "fail", detail: String(e) })
      );

    // Node outbound-fetch self-test — reports the exact error as data.
    fetch(`${gateway.origin}/nettest?url=${encodeURIComponent("https://example.com/")}&t=${gateway.token}`)
      .then((r) => r.json())
      .then((r) =>
        set("nettest", {
          label: "Node outbound HTTPS (example.com)",
          status: r.ok ? "pass" : "fail",
          detail: r.ok
            ? `${r.bytes} bytes${r.insecure ? " (TLS verify off)" : ""}`
            : r.error,
        })
      )
      .catch((e) =>
        set("nettest", { label: "Node outbound HTTPS", status: "fail", detail: String(e) })
      );

    // Proxy BACKEND self-test — full fetch+rewrite pipeline.
    fetch(
      `${gateway.origin}/proxy?url=${encodeURIComponent("https://example.com/")}&t=${gateway.token}`
    )
      .then(async (r) => {
        const text = await r.text();
        const ok = r.ok && /Example Domain/i.test(text);
        set("proxy", {
          label: "Web proxy (backend fetch+rewrite)",
          status: ok ? "pass" : "fail",
          detail: ok
            ? `${text.length} bytes, rewritten`
            : `status ${r.status}, ${text.slice(0, 80)}`,
        });
      })
      .catch((e) =>
        set("proxy", {
          label: "Web proxy (backend fetch+rewrite)",
          status: "fail",
          detail: String(e),
        })
      );
  }, [gateway]);

  const testEyeDropper = () => {
    if (!("EyeDropper" in window)) return;
    new (window as any).EyeDropper()
      .open()
      .then((r: any) =>
        set("eyedropper-open", {
          label: "EyeDropper pick test",
          status: "pass",
          detail: `picked ${r.sRGBHex}`,
        })
      )
      .catch((e: any) =>
        set("eyedropper-open", {
          label: "EyeDropper pick test",
          status: String(e).includes("Abort") ? "manual" : "fail",
          detail: String(e),
        })
      );
  };

  const testImport = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#8f97f8";
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = "#141416";
      ctx.font = "40px sans-serif";
      ctx.fillText("ね", 12, 46);
      const b64 = canvas.toDataURL("image/png").split(",")[1];
      const file = path.join(os.tmpdir(), "nekomitai-diag.png");
      fs.writeFileSync(file, buffer.Buffer.from(b64, "base64"));
      evalTS("importFootage", file.replace(/\\/g, "\\\\"), false).then(
        (res: any) =>
          set("import", {
            label: "Import round-trip (PNG → project)",
            status: res && res.ok ? "pass" : "fail",
            detail: res && res.ok ? `imported "${res.name}" into Nekomitai bin` : JSON.stringify(res),
          }),
        (e) =>
          set("import", {
            label: "Import round-trip (PNG → project)",
            status: "fail",
            detail: String(e && e.message ? e.message : e),
          })
      );
    } catch (e) {
      set("import", {
        label: "Import round-trip (PNG → project)",
        status: "fail",
        detail: String(e),
      });
    }
  };

  const testAdblock = () => {
    if (!gateway) return;
    set("adblock", { label: "Adblock engine", status: "pending", detail: "loading lists…" });
    fetch(`${gateway.origin}/adblock/selftest?t=${gateway.token}`)
      .then((r) => r.json())
      .then((r) =>
        set("adblock", {
          label: "Adblock engine",
          status: r.ok && r.blocked >= 3 ? "pass" : "fail",
          detail: r.ok
            ? `blocked ${r.blocked}/${r.total} known ad URLs · lists ${r.listVersion}`
            : r.error || "engine failed",
        })
      )
      .catch((e) => set("adblock", { label: "Adblock engine", status: "fail", detail: String(e) }));
  };

  const manualVerdict = (key: string, label: string, ok: boolean) =>
    set(key, {
      label,
      status: ok ? "pass" : "fail",
      detail: ok ? "confirmed by user" : "reported broken by user",
    });

  const copyReport = () => {
    const lines = Object.values(results).map(
      (r) => `[${r.status.toUpperCase()}] ${r.label}${r.detail ? " — " + r.detail : ""}`
    );
    const text = `Nekomitai diagnostics · ${navigator.userAgent}\n` + lines.join("\n");
    navigator.clipboard?.writeText(text).catch(() => {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    });
  };

  return (
    <div className="nm-diag">
      <div className="nm-diag-head">
        <h2>Diagnostics — M0 spike checks</h2>
        <button onClick={copyReport}>Copy report</button>
      </div>

      <ul className="nm-diag-list">
        {Object.entries(results).map(([key, r]) => (
          <li key={key}>
            <span className={`nm-chip ${r.status}`}>{r.status}</span>
            <span className="nm-diag-label">{r.label}</span>
            <span className="nm-diag-detail">{r.detail}</span>
          </li>
        ))}
      </ul>

      <div className="nm-diag-actions">
        <button onClick={testImport}>Run import test</button>
        <button onClick={testEyeDropper} disabled={!("EyeDropper" in window)}>
          Run EyeDropper test
        </button>
        <button onClick={() => setYtVisible(true)}>Load YouTube embed test</button>
        <button onClick={() => setTwVisible(true)}>Load Twitch embed test</button>
        <button onClick={() => setWebVisible(true)}>Load Web Mode test</button>
        <button onClick={testAdblock}>Test adblock engine</button>
      </div>

      {ytVisible && gateway && (
        <div className="nm-diag-embed">
          <iframe
            src={`${gateway.viewOrigin}/view?target=${encodeURIComponent(
              `https://www.youtube.com/watch?v=${YT_TEST_ID}`
            )}&t=${gateway.token}`}
            title="YouTube test"
          />
          <div className="nm-diag-verdict">
            <span>Did the video play (picture + sound)?</span>
            <button onClick={() => manualVerdict("yt", "YouTube embed playback", true)}>Yes</button>
            <button onClick={() => manualVerdict("yt", "YouTube embed playback", false)}>No</button>
          </div>
        </div>
      )}

      {twVisible && gateway && (
        <div className="nm-diag-embed">
          <iframe
            src={`${gateway.viewOrigin}/view?target=${encodeURIComponent(
              "https://www.twitch.tv/monstercat"
            )}&t=${gateway.token}`}
            title="Twitch test"
          />
          <div className="nm-diag-verdict">
            <span>Did the Twitch stream load? (checks the parent-domain rule)</span>
            <button onClick={() => manualVerdict("twitch", "Twitch embed playback", true)}>Yes</button>
            <button onClick={() => manualVerdict("twitch", "Twitch embed playback", false)}>No</button>
          </div>
        </div>
      )}

      {webVisible && gateway && (
        <div className="nm-diag-embed">
          <iframe
            src={`${gateway.viewOrigin}/view?target=${encodeURIComponent(
              "https://en.wikipedia.org/wiki/After_Effects"
            )}&t=${gateway.token}`}
            title="Web Mode test"
          />
          <div className="nm-diag-verdict">
            <span>Did the Wikipedia page render (proxy strips framing headers)?</span>
            <button onClick={() => manualVerdict("web", "Web Mode proxy", true)}>Yes</button>
            <button onClick={() => manualVerdict("web", "Web Mode proxy", false)}>No</button>
          </div>
        </div>
      )}
    </div>
  );
};
