import { useEffect, useState } from "react";
import { subscribeBackgroundColor, openLinkInBrowser } from "../lib/utils/bolt";
import { startGateway, GatewayInfo } from "../lib/gateway/server";
import { Browser } from "./browser/Browser";
import { Boards } from "./boards/Boards";
import { Diagnostics } from "./diagnostics/Diagnostics";
import { Settings } from "./settings/Settings";
import { About } from "./about/About";
import { IconShield } from "./icons";
import banner from "./assets/banner_icon.png?inline";
import "./main.scss";

type Route = "browser" | "boards" | "diagnostics" | "settings" | "about";

const routeFromHash = (): Route => {
  const h = location.hash.replace(/^#\/?/, "");
  if (h === "boards" || h === "diagnostics" || h === "settings" || h === "about")
    return h;
  return "browser";
};

/** Derive panel palette from AE's own appearance so the panel feels native. */
const applyTheme = (rgbCss: string) => {
  const m = rgbCss.match(/(\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const light = r + g + b > 382; // AE in a bright appearance setting
  const shade = (amt: number) =>
    `rgb(${clamp(r + amt)}, ${clamp(g + amt)}, ${clamp(b + amt)})`;
  const root = document.documentElement.style;
  root.setProperty("--nm-bg", `rgb(${r}, ${g}, ${b})`);
  root.setProperty("--nm-surface", shade(light ? -12 : 10));
  root.setProperty("--nm-surface-2", shade(light ? -24 : 20));
  root.setProperty("--nm-line", shade(light ? -40 : 34));
  root.setProperty("--nm-ink", light ? "#1f2024" : "#e8e9ee");
  root.setProperty("--nm-muted", light ? "#5d6070" : "#9ea1ac");
  root.setProperty("--nm-accent", light ? "#4a53cc" : "#8f97f8");
  // wordmark PNG is white — flip it to ink on bright AE appearances
  root.setProperty("--nm-logo-filter", light ? "invert(0.88)" : "none");
};
const clamp = (n: number) => Math.max(0, Math.min(255, n));

export const App = () => {
  const [route, setRoute] = useState<Route>(routeFromHash());
  const [gateway, setGateway] = useState<GatewayInfo | null>(null);
  const [gatewayError, setGatewayError] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (window.cep) {
      subscribeBackgroundColor(applyTheme);
      startGateway().then(setGateway, (e) => setGatewayError(String(e)));
    } else {
      setGatewayError("Not running inside CEP (browser dev mode)");
    }
  }, []);

  // View-surface pages talk back via postMessage (they have no CEP access).
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!e.data) return;
      if (e.data.nm === "openExternal" && typeof e.data.url === "string") {
        openLinkInBrowser(e.data.url);
      } else if (e.data.nm === "route" && typeof e.data.to === "string") {
        // A view page asking the shell to switch screens — the Spotify
        // preview notice pointing at Settings is the one caller today.
        location.hash = "#/" + e.data.to.replace(/[^a-z]/g, "");
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // shield badge — reflects adblock state + blocked count
  const [shield, setShield] = useState<{ on: boolean; blocked: number }>({
    on: false,
    blocked: 0,
  });
  useEffect(() => {
    if (!gateway) return;
    const poll = () =>
      fetch(`${gateway.origin}/adblock/status?t=${gateway.token}`)
        .then((r) => r.json())
        .then((s) =>
          setShield({ on: !!(s.adblock || s.antitrack), blocked: s.blocked || 0 })
        )
        .catch(() => {});
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [gateway]);

  const nav = (r: Route) => (location.hash = `#/${r}`);

  return (
    <div className="nm-app">
      <header className="nm-topnav">
        <span className="nm-logo">
          <img className="nm-logo-img" src={banner} alt="NekoMitai" />
        </span>
        <nav>
          {(
            ["browser", "boards", "diagnostics", "settings", "about"] as Route[]
          ).map((r) => (
            <button
              key={r}
              className={route === r ? "active" : ""}
              onClick={() => nav(r)}
            >
              {r === "browser" ? "Browse" : r[0].toUpperCase() + r.slice(1)}
            </button>
          ))}
        </nav>
        {shield.on && (
          <button
            className="nm-shield"
            onClick={() => nav("settings")}
            title={`Ad/tracker blocking on — ${shield.blocked} blocked this session`}
          >
            <IconShield /> {shield.blocked}
          </button>
        )}
        <span
          className={`nm-gw-dot ${gateway ? "ok" : gatewayError ? "err" : ""}`}
          title={
            gateway
              ? `Gateway running on ${gateway.origin}`
              : gatewayError || "Gateway starting…"
          }
        />
      </header>

      <main className="nm-content">
        {/* Browser stays mounted on every screen so tab media keeps playing
            while the user visits Boards/Settings/etc. — only hidden via CSS */}
        <div className={`nm-keepalive ${route === "browser" ? "" : "hidden"}`}>
          <Browser gateway={gateway} gatewayError={gatewayError} />
        </div>
        {route === "boards" && <Boards gateway={gateway} />}
        {route === "diagnostics" && <Diagnostics gateway={gateway} />}
        {route === "settings" && <Settings gateway={gateway} />}
        {route === "about" && <About />}
      </main>
    </div>
  );
};
