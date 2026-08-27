import { useEffect, useRef, useState } from "react";
import type { GatewayInfo } from "../../lib/gateway/server";
import { aeAddSolid, aeImportFootage, aeProjectInfo } from "../../lib/ae";
import { csi, evalES } from "../../lib/utils/bolt";
import {
  loadBoards,
  saveBoards,
  thumbFor,
  newId,
  GLOBAL_KEY,
} from "../../lib/boards";
import {
  IconStar,
  IconEyedrop,
  IconVolume,
  IconVolumeMuted,
  IconDuck,
} from "../icons";

type Tab = {
  id: number;
  input: string;
  target: string | null; // what the iframe was told to load (remounts on change)
  current: string | null; // real URL the page reports as it navigates
};
type Meta = {
  provider: string;
  controllable: boolean;
  mediaUrl?: string;
  videoId?: string;
};
type DuckMode = "muted" | "paused" | null;
type Cmd = {
  action: "duck" | "resume" | "volume" | "play" | "pause" | "seek" | "rate";
  value?: number;
};

let nextId = 1;

export const Browser = ({
  gateway,
  gatewayError,
}: {
  gateway: GatewayInfo | null;
  gatewayError: string | null;
}) => {
  const [tabs, setTabs] = useState<Tab[]>([
    { id: 0, input: "", target: null, current: null },
  ]);
  const [activeId, setActiveId] = useState(0);
  const [metas, setMetas] = useState<Record<number, Meta>>({});
  const [duckModes, setDuckModes] = useState<Record<number, DuckMode>>({});
  // per-tab audibility, reported by view pages ({nm:"sound"}). A tab with no
  // report yet counts as audible (conservative — the duck watchdog must never
  // sit out a tab that might be making sound).
  const [sounds, setSounds] = useState<Record<number, boolean>>({});
  const [status, setStatus] = useState("");
  const [followAE, setFollowAE] = useState(true);
  const [aeBusy, setAeBusy] = useState(false);
  const [volume, setVolume] = useState(1);
  const inputRef = useRef<HTMLInputElement>(null);
  const frameRefs = useRef(new Map<number, HTMLIFrameElement>());
  const restored = useRef(false);
  const metasRef = useRef(metas);
  const volumeRef = useRef(volume);
  const sendAllRef = useRef<(cmd: Cmd) => void>(() => {});
  const autoDucked = useRef(false);
  // ExtendScript-safety state for the duck watchdog. Lives OUTSIDE the
  // watchdog effect: the effect remounts whenever anyAudible/followAE/gateway
  // change, and a remount must not forget a dialog chain in progress, a
  // refusal backoff, or a dead sidecar — forgetting any of those reopens the
  // "evalScript into a modal dialog" alert this state exists to prevent.
  const esGuard = useRef({
    sampleAt: 0, // when the sidecar last gave a definite answer
    sampleModal: false, // that answer: a modal dialog is up in AfterFX
    sampleBlocked: false, // that answer: AE's UI thread isn't answering
    unsafeAt: 0, // last sample that said modal or blocked
    wasModal: false, // previous sample's modal flag (edge detection)
    meterDead: false, // the sidecar has given up — fall back to grace gating
    graceFrom: 0, // first-ever watchdog mount, for the no-sidecar grace
    backoff: 5000, // = BACKOFF_MIN
    backoffUntil: 0, // engine refused a call (modal dialog up / teardown)
  });

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  metasRef.current = metas;
  volumeRef.current = volume;

  // restore last session's tabs once the gateway is up
  useEffect(() => {
    if (!gateway || restored.current) return;
    restored.current = true;
    fetch(`${gateway.origin}/session?t=${gateway.token}`)
      .then((r) => r.json())
      .then((r) => {
        const targets: string[] = r?.session?.tabs || [];
        if (targets.length) {
          setTabs(
            targets.map((t) => ({ id: nextId++, input: t, target: t, current: t }))
          );
        }
      })
      .catch(() => {});
  }, [gateway]);

  // persist open tabs (their live URLs) whenever they change (after restore)
  useEffect(() => {
    if (!gateway || !restored.current) return;
    const targets = tabs
      .map((t) => t.current || t.target)
      .filter(Boolean) as string[];
    const id = setTimeout(() => {
      fetch(`${gateway.origin}/session?t=${gateway.token}`, {
        method: "POST",
        body: JSON.stringify({ tabs: targets }),
      }).catch(() => {});
    }, 400);
    return () => clearTimeout(id);
  }, [tabs, gateway]);

  // open URLs sent from the Boards screen
  useEffect(() => {
    const onOpen = (e: Event) => {
      const url = (e as CustomEvent).detail as string;
      if (!url) return;
      const tab = { id: nextId++, input: url, target: url, current: url };
      setTabs((ts) => [...ts, tab]);
      setActiveId(tab.id);
      location.hash = "#/browser";
    };
    window.addEventListener("nm:open", onOpen);
    return () => window.removeEventListener("nm:open", onOpen);
  }, []);

  const update = (id: number, patch: Partial<Tab>) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  // messages from the view iframes: identify the sender tab by its window
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (!d || typeof d !== "object") return;
      let from: number | null = null;
      frameRefs.current.forEach((el, id) => {
        if (el && el.contentWindow === e.source) from = id;
      });
      if (from === null) return;
      const tabId: number = from;
      if (d.nm === "meta") {
        setMetas((m) => ({
          ...m,
          [tabId]: {
            provider: d.provider,
            controllable: !!d.controllable,
            mediaUrl: d.mediaUrl,
            videoId: d.videoId,
          },
        }));
      } else if (d.nm === "nav" && typeof d.url === "string") {
        // page navigated inside its frame — reflect the real URL in the tab
        setTabs((ts) =>
          ts.map((t) => (t.id === tabId ? { ...t, current: d.url, input: d.url } : t))
        );
        // the frame may have crossed tiers (web page → embed/media player or
        // back) — drop stale meta/duck state; a view page re-posts meta next
        setMetas((m) => {
          if (!(tabId in m)) return m;
          const n = { ...m };
          delete n[tabId];
          return n;
        });
        setDuckModes((m) => {
          if (!(tabId in m)) return m;
          const n = { ...m };
          delete n[tabId];
          return n;
        });
        setSounds((m) => {
          if (!(tabId in m)) return m;
          const n = { ...m };
          delete n[tabId];
          return n;
        });
      } else if (d.nm === "duckState") {
        setDuckModes((m) => ({ ...m, [tabId]: (d.mode ?? null) as DuckMode }));
      } else if (d.nm === "sound") {
        const on = !!d.on;
        setSounds((m) => (m[tabId] === on ? m : { ...m, [tabId]: on }));
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const sendAll = (cmd: Cmd) => {
    frameRefs.current.forEach((el) => {
      try {
        el?.contentWindow?.postMessage({ nm: "cmd", ...cmd }, "*");
      } catch {
        /* frame mid-navigation */
      }
    });
  };
  sendAllRef.current = sendAll;

  // Duck the reference audio in EVERY tab while the AE timeline is PLAYING and
  // restore it when it stops. Ducking PAUSES wherever the view page can see
  // real playback state (YouTube, Vimeo, SoundCloud, Spotify, media files) so
  // the reference keeps its place; it falls back to muting where it can't
  // (Dailymotion) — each view page picks its own mode.
  // Only real playback ducks — dragging the CTI (scrubbing) deliberately does
  // NOT. Two signals, either of which marks playback:
  //  1. AfterFX's Windows audio session emitting sound (preview with audio,
  //     audio-scrub too), sampled by the gateway's WASAPI meter (/aepeak);
  //  2. an in-AE scheduleTask heartbeat that PUSHES a CSXS event to the panel
  //     every 300ms. Preview starves idle tasks, so the events going quiet
  //     marks a possible preview — then ONE evalScript ping's RTT separates
  //     preview (engine answers fast while tasks stall, covering silent
  //     comps) from a CTI drag / heavy UI (the ping comes back late).
  // ExtendScript is called ONLY when the events starve — never on a timer —
  // because while a modal dialog is up in AE every evalScript is refused WITH
  // a modal error alert shoved at the user. The sidecar's /aepeak response
  // carries "modal dialog up" and "UI thread blocked" flags; every evalScript
  // here requires a FRESH sample with both clear (see safeForES), and a
  // refusal that slips through anyway backs off exponentially.
  // The whole watchdog (the in-AE heartbeat task, the /aepeak polling, any
  // pings) runs ONLY while some tab is actually audible — an open but silent
  // tab (paused video, a docs page) must cost AE nothing. Tabs that never
  // report a sound state count as audible, so ducking can only ever fail
  // toward "still works, just not cheaper".
  const anyAudible = tabs.some((t) => t.target && (sounds[t.id] ?? true));
  useEffect(() => {
    if (!followAE || !anyAudible || !window.cep) return;
    const POLL_MS = 250; // watchdog tick (re-duck, arming, starvation checks)
    const AUDIO_POLL_MS = 150; // /aepeak cadence (sidecar samples every 80ms)
    const IDLE_MS = 500; // keep ducked this long after the last playback sign
    const AUDIO_HOLD_MS = 400; // bridge brief quiet gaps in previewed audio
    const AUDIO_PEAK_MIN = 0.01; // WASAPI peak (0..1) that counts as sound
    const HB_STALE_MS = 1000; // events starved this long = maybe previewing
    const HB_RTT_MAX = 250; // trust starvation only if the ping answered fast
    const HB_DEAD_MS = 30000; // starved THIS long = heartbeat lost, re-arm
    const REDUCK_MS = 1000; // re-broadcast duck while busy (idempotent) so
    // frames that (re)load mid-preview still duck
    const SAFE_FRESH_MS = 600; // a "coast is clear" verdict needs a sidecar
    // sample this recent (steady cadence is ~150ms)
    const QUIET_MS = 800; // no ExtendScript this long after a sample that said
    // modal/blocked — dialogs come in chains (file picker, then "missing
    // footage") with gaps our sampling latency can't see into
    const BACKOFF_MIN = 5000; // after a refused evalScript wait at least this,
    const BACKOFF_MAX = 60000; // doubling per refusal up to this
    const FALLBACK_AFTER_MS = 5000; // armed but no event ever this long → the
    // event channel is broken, fall back to legacy ping polling
    const GRACE_MS = 1500; // non-Windows only: there is no sidecar to ask
    let pending = false;
    let pendingSince = 0;
    let sustainedUntil = 0; // busy until this time
    let busy = false;
    let hbSeen = false; // (fallback path) heartbeat observed alive via gap
    let disposed = false;
    let lastDuckSent = 0;
    let audioTimer: ReturnType<typeof setTimeout> | undefined;
    let lastHb = 0; // last nm.hb CSXS event from the in-AE heartbeat task
    let hbEverSeen = false; // the event channel is proven to work
    let armedAt = 0;
    let lastArmTry = 0;
    const g = esGuard.current; // remount-surviving safety state — see its decl
    const isWin = navigator.platform.toLowerCase().includes("win");
    // Anchored to the FIRST mount, not this one: the grace covers panel
    // startup, when a dialog may already be up and no sample can say so. A
    // later remount (a tab going quiet mid-preview) must not re-impose a
    // blackout on a panel that has been alive for minutes.
    if (!g.graceFrom) g.graceFrom = Date.now();

    // While a modal dialog is up in AE, EVERY evalScript is refused and AE
    // alerts "Unable to execute script… Cannot run a script while a modal
    // dialog is waiting for response" AT the user. And an evalScript issued
    // while AE's UI thread is blocked (opening/closing a project) sits queued
    // until AE gets back to it — often the exact moment a load-time dialog
    // has appeared, same alert. So nothing below may call evalES unless a
    // FRESH sidecar sample says "no modal, UI thread answering", never within
    // QUIET_MS of a sample that said otherwise, and never while a refusal has
    // us backing off. On Windows, no sample means NO call — at AE startup the
    // sidecar takes seconds to compile while open-time dialogs are likeliest,
    // and arming blind there was exactly the reported bug. Where the sidecar
    // can't exist (macOS) or has given up for good (meterDead — PowerShell
    // blocked by policy), a short post-mount grace is the best we have; that
    // keeps auto-duck alive there at the old pre-sidecar alert risk instead
    // of silently disabling it.
    const safeForES = () => {
      const now = Date.now();
      if (now < g.backoffUntil) return false;
      if (g.unsafeAt && now - g.unsafeAt < QUIET_MS) return false;
      if (!isWin || g.meterDead) return now - g.graceFrom > GRACE_MS;
      return (
        g.sampleAt > 0 &&
        now - g.sampleAt < SAFE_FRESH_MS &&
        !g.sampleModal &&
        !g.sampleBlocked
      );
    };

    // The in-AE heartbeat pushes to the panel — steady state costs zero
    // evalScript calls; the panel only ever pings when the events starve.
    const onHb = () => {
      lastHb = Date.now();
      hbEverSeen = true;
    };
    csi.addEventListener("nm.hb", onHb);

    const armHeartbeat = () => {
      if (!safeForES()) return; // the loop retries
      lastArmTry = Date.now();
      evalES(
        "(function(){try{if($.global.__nmHbId)app.cancelTask($.global.__nmHbId);}catch(e){}" +
          'try{if(!$.global.__nmXt)$.global.__nmXt=new ExternalObject("lib:PlugPlugExternalObject");}catch(e){}' +
          "$.global.__nmHb=new Date().getTime();$.global.__nmHbId=app.scheduleTask(" +
          "\"$.global.__nmHb=new Date().getTime();try{var e=new CSXSEvent();e.type='nm.hb';e.data='hb';e.dispatch();}catch(x){}\"" +
          ',300,true);return "ok";})()',
        true
      )
        .then((res) => {
          if (String(res) === "ok") armedAt = Date.now();
          else {
            // refused (a modal raced us) — treat like a refused ping
            g.backoffUntil = Date.now() + g.backoff;
            g.backoff = Math.min(g.backoff * 2, BACKOFF_MAX);
          }
        })
        .catch(() => {});
    };
    // Deliberately NOT armed here: a modal could be up right now and we can't
    // know until the sidecar's first sample lands. The interval below arms as
    // soon as a fresh sample says it's safe (on non-Windows, after the grace).

    // The repeating scheduleTask lives inside AE, not the panel — if the page
    // is torn down without cleanup (panel closed, AE quitting) it keeps firing
    // until AE dies. Cancel it on pagehide too, since React cleanup never
    // runs on page teardown — but ONLY when it's provably safe (AE's
    // quit-time "Save changes?" included): the cancel itself would be refused
    // with an alert, and the orphaned task is harmless — its body is
    // try/caught, it starves while any modal is up, and re-arming replaces it
    // by id.
    const cancelHeartbeat = () => {
      if (!safeForES()) return;
      evalES(
        '(function(){try{if($.global.__nmHbId){app.cancelTask($.global.__nmHbId);$.global.__nmHbId=0;}}catch(e){}return "ok";})()',
        true
      ).catch(() => {});
    };
    window.addEventListener("pagehide", cancelHeartbeat);

    const setBusy = (b: boolean) => {
      if (b === busy) return;
      busy = b;
      setAeBusy(b);
      if (b) {
        sendAllRef.current({ action: "duck" });
        lastDuckSent = Date.now();
        autoDucked.current = true;
      } else if (autoDucked.current) {
        sendAllRef.current({ action: "resume" });
        autoDucked.current = false;
      }
    };

    // Re-evaluate busy the moment any signal lands — never wait for a tick.
    const evaluate = () => {
      if (!disposed) setBusy(Date.now() < sustainedUntil);
    };
    const bump = (holdMs: number) => {
      sustainedUntil = Math.max(sustainedUntil, Date.now() + holdMs);
      evaluate();
    };

    // signal 2: AE itself is emitting audio (preview/scrub with sound).
    // Dedicated fast loop — each response acts immediately, then re-arms.
    // The same response carries the sidecar's "modal dialog up" and "UI
    // thread blocked" flags that gate every evalScript in this watchdog.
    const pollAudio = () => {
      if (disposed || !gateway) return;
      fetch(`${gateway.origin}/aepeak?t=${gateway.token}`)
        .then((r) => r.json())
        .then((r) => {
          if (r?.ok && typeof r.modal === "boolean") {
            g.meterDead = false;
            // r.at is the sidecar's production time — same machine clock, and
            // honest about hiccups the gateway's own 2s staleness window hides
            g.sampleAt =
              typeof r.at === "number" && r.at > 0 ? r.at : Date.now();
            g.sampleModal = r.modal;
            g.sampleBlocked = r.busy === true;
            if (g.sampleModal || g.sampleBlocked) g.unsafeAt = Date.now();
            // a dialog just closed — whatever starvation the heartbeat
            // accumulated behind it says nothing about preview; make a ping
            // wait for a fresh HB_STALE_MS of silence first
            if (g.wasModal && !g.sampleModal) lastHb = Date.now();
            g.wasModal = g.sampleModal;
          } else if (r?.ok && r.dead === true) {
            g.meterDead = true; // no sidecar will ever answer — grace gating
          }
          if (r?.ok && r.peak > AUDIO_PEAK_MIN) bump(AUDIO_HOLD_MS);
          else evaluate(); // prompt resume once the hold expires
          audioTimer = setTimeout(pollAudio, AUDIO_POLL_MS);
        })
        .catch(() => {
          audioTimer = setTimeout(pollAudio, 1000);
        });
    };
    pollAudio();

    const id = setInterval(() => {
      const now = Date.now();
      evaluate();

      // keep late-loading frames ducked during a long busy stretch
      if (busy && now - lastDuckSent > REDUCK_MS) {
        sendAllRef.current({ action: "duck" });
        lastDuckSent = now;
      }

      // A ducked silent-comp preview is sustained purely by pings. If a
      // transient busy/modal sample vetoes them while the heartbeat is still
      // starved, hold the duck rather than audibly resuming the reference for
      // an 800ms gap and re-pausing it (a paused reference through a dialog
      // is benign; a mid-preview flap is not). Events resuming — the real
      // "preview over" signal — end the starvation and release normally.
      if (
        busy &&
        armedAt > 0 &&
        hbEverSeen &&
        now - lastHb > HB_STALE_MS &&
        !safeForES()
      ) {
        bump(IDLE_MS);
      }

      // arm (or re-arm, after the heartbeat was found dead below) the moment
      // a fresh sidecar sample confirms the coast is clear
      if (!armedAt && now - lastArmTry > 2000 && safeForES()) {
        armHeartbeat();
      }

      // signal 1: heartbeat starvation. Events flowing = engine idle-healthy
      // — nothing to do and nothing to ask AE. Only when they starve do we
      // ping: ONE evalScript whose RTT separates preview (fast — the engine
      // answers while idle tasks stall) from a CTI drag / heavy UI (slow) —
      // dragging must never duck. A modal dialog also starves the events, but
      // the sidecar flags veto the ping so AE is never asked then. No pings
      // at all unless WE armed a heartbeat this session — a dead one would
      // read as eternal starvation and ping 4x/s into every future dialog.
      const wantPing =
        armedAt > 0 &&
        (hbEverSeen
          ? now - lastHb > HB_STALE_MS
          : now - armedAt > FALLBACK_AFTER_MS); // event channel broken →
      // legacy 250ms ping polling (still sidecar-vetoed)
      // The fallback path pings continuously instead of on starvation, so at
      // a UI-block onset it would fire on a just-pre-block clear sample; the
      // heartbeat path is safe there because its 1s starvation requirement
      // outlasts block-detection latency. Demand a near-live sample from the
      // fallback to shrink that window.
      const fallbackFresh =
        hbEverSeen || !isWin || g.meterDead || now - g.sampleAt < 300;
      if (wantPing && !pending && fallbackFresh && safeForES()) {
        pending = true;
        pendingSince = now;
        evalES(
          "(function(){var hb=$.global.__nmHb||0;return hb?String(new Date().getTime()-hb):'-1';})()",
          true
        )
          .then((res) => {
            pending = false;
            const rtt = Date.now() - pendingSince;
            const gap = Number(String(res));
            // Non-numeric result = the engine refused the call (a modal the
            // sidecar sample missed, quit teardown). Every further call would
            // alert at the user — back off, doubling each refusal, until the
            // events or the modal flag say the coast is clear.
            if (!isFinite(gap)) {
              g.backoffUntil = Date.now() + g.backoff;
              g.backoff = Math.min(g.backoff * 2, BACKOFF_MAX);
              return;
            }
            g.backoff = BACKOFF_MIN;
            if (gap < 0 || gap > HB_DEAD_MS) {
              // $.global.__nmHb is missing or ancient — the engine was reset
              // or the task cancelled (project close does this). Stop pinging
              // immediately and let the arm branch above re-establish the
              // heartbeat under the same safety gates. (gap of -1 used to
              // slip past a `> HB_DEAD_MS` check, leaving a dead heartbeat
              // pinging 4x/s forever — the open/close alert generator.)
              armedAt = 0;
              hbSeen = false;
              return;
            }
            if (gap < HB_STALE_MS) hbSeen = true;
            const starved = hbEverSeen
              ? gap > HB_STALE_MS && Date.now() - lastHb > HB_STALE_MS
              : hbSeen && gap > HB_STALE_MS;
            if (starved && rtt < HB_RTT_MAX) bump(IDLE_MS);
          })
          .catch(() => {
            pending = false;
          });
      }
    }, POLL_MS);

    return () => {
      disposed = true;
      clearInterval(id);
      if (audioTimer) clearTimeout(audioTimer);
      csi.removeEventListener("nm.hb", onHb);
      window.removeEventListener("pagehide", cancelHeartbeat);
      cancelHeartbeat();
      if (autoDucked.current) sendAllRef.current({ action: "resume" });
      autoDucked.current = false;
      setAeBusy(false);
    };
  }, [followAE, gateway, anyAudible]);

  const go = () => {
    const value = inputRef.current?.value.trim();
    if (!value) return;
    update(active.id, { input: value, target: value, current: value });
    setMetas((m) => {
      const n = { ...m };
      delete n[active.id];
      return n;
    });
    setSounds((m) => {
      const n = { ...m };
      delete n[active.id];
      return n;
    });
  };

  const addTab = () => {
    const tab = { id: nextId++, input: "", target: null, current: null };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  };

  const closeTab = (id: number) => {
    setTabs((ts) => {
      const rest = ts.filter((t) => t.id !== id);
      return rest.length === 0
        ? [{ id: nextId++, input: "", target: null, current: null }]
        : rest;
    });
    setMetas((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });
    setDuckModes((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });
    setSounds((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });
    if (id === activeId) {
      const idx = tabs.findIndex((t) => t.id === id);
      const neighbor = tabs[idx - 1] ?? tabs[idx + 1];
      if (neighbor) setActiveId(neighbor.id);
    }
  };

  const viewUrl = (target: string) =>
    gateway
      ? `${gateway.viewOrigin}/view?target=${encodeURIComponent(target)}&t=${gateway.token}`
      : null;

  // a frame (re)loaded: hand it the current volume; ducking catches up via
  // the watchdog's periodic re-broadcast
  const onFrameLoad = (id: number) => {
    const el = frameRefs.current.get(id);
    if (!el) return;
    try {
      if (volumeRef.current < 1)
        el.contentWindow?.postMessage(
          { nm: "cmd", action: "volume", value: volumeRef.current },
          "*"
        );
    } catch {
      /* ignore */
    }
  };

  // Eyedropper → new comp solid
  const pickColor = async () => {
    if (!("EyeDropper" in window)) return setStatus("EyeDropper unavailable");
    try {
      const res = await new (window as any).EyeDropper().open();
      const hex: string = res.sRGBHex;
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const out = await aeAddSolid(r, g, b, `Nekomitai ${hex}`);
      setStatus(out.ok ? `Solid ${hex} created` : out.error);
    } catch {
      /* user cancelled */
    }
  };

  const activeMeta = metas[active.id];

  // download current media/image and import to the project
  const sendToAE = async (addToComp: boolean) => {
    const url = activeMeta?.mediaUrl;
    if (!url || !gateway) return setStatus("Nothing importable on this tab");
    setStatus("Downloading…");
    try {
      const res = await fetch(
        `${gateway.origin}/download?url=${encodeURIComponent(url)}&t=${gateway.token}`
      ).then((r) => r.json());
      if (!res.ok) return setStatus("Download failed: " + res.error);
      const imp = await aeImportFootage(res.path.replace(/\\/g, "\\\\"), addToComp);
      setStatus(imp.ok ? `Imported ${res.name}` : imp.error);
    } catch (e) {
      setStatus("Import failed: " + String(e));
    }
  };

  const canImport =
    activeMeta?.provider === "media" || activeMeta?.provider === "image";

  // bookmark the active tab into a board for the current project
  const saveToBoard = async () => {
    const url = active.current || active.target;
    if (!gateway || !url) return;
    const proj = await aeProjectInfo();
    const key = proj.ok && proj.projectPath ? proj.projectPath : GLOBAL_KEY;
    const data = await loadBoards(gateway);
    const list = data[key] || [];
    if (list.length === 0)
      list.push({ id: newId(), name: "Saved", items: [] });
    const board = list[0];
    if (!board.items.some((i) => i.url === url)) {
      board.items.unshift({
        url,
        title: shortTitle(url),
        thumb: thumbFor(url, metasRef.current[active.id]?.videoId),
        addedAt: Date.now(),
      });
    }
    await saveBoards(gateway, { ...data, [key]: list });
    setStatus(`Saved to "${board.name}"`);
  };

  const activeDuck = duckModes[active.id] ?? null;

  return (
    <div className="nm-browser">
      <div className="nm-tabstrip">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`nm-tab ${t.id === active.id ? "active" : ""}`}
            onClick={() => setActiveId(t.id)}
          >
            <span className="nm-tab-title">
              {t.current || t.target ? shortTitle((t.current || t.target)!) : "New tab"}
            </span>
            <button
              className="nm-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
              aria-label="Close tab"
            >
              ×
            </button>
          </div>
        ))}
        <button className="nm-tab-add" onClick={addTab} aria-label="New tab">
          +
        </button>
      </div>

      <div className="nm-omnibar">
        <input
          ref={inputRef}
          key={`${active.id}:${active.input}`}
          defaultValue={active.input}
          placeholder="Search, or paste any URL — video links, Spotify, or any website…"
          onKeyDown={(e) => e.key === "Enter" && go()}
          spellCheck={false}
        />
        <button onClick={go}>Go</button>
        {(active.current || active.target) && (
          <button className="nm-tool" onClick={saveToBoard} title="Save to a reference board">
            <IconStar />
          </button>
        )}
        <button className="nm-tool" onClick={pickColor} title="Eyedrop a color into a new solid">
          <IconEyedrop />
        </button>
        {canImport && (
          <>
            <button className="nm-tool" onClick={() => sendToAE(false)} title="Import to project bin">
              ⬇
            </button>
            <button className="nm-tool" onClick={() => sendToAE(true)} title="Import and add to active comp">
              ↦
            </button>
          </>
        )}
      </div>

      {status && <div className="nm-statusline">{status}</div>}

      <div className="nm-viewport">
        {!gateway && (
          <div className="nm-placeholder">
            <h2>{gatewayError ? "Gateway failed to start" : "Starting…"}</h2>
            {gatewayError && <p>{gatewayError}</p>}
          </div>
        )}
        {gateway && !active.target && (
          <div className="nm-placeholder">
            <h2>ねこみたい</h2>
            <p>
              Type a search or paste any URL. Media links (YouTube, Vimeo,
              Dailymotion, SoundCloud, Spotify) play in their own player;
              everything else — docs, references — opens as a full web page.
            </p>
          </div>
        )}
        {gateway &&
          tabs
            .filter((t) => t.target)
            .map((t) => (
              // every tab stays mounted so switching tabs (or leaving the
              // Browse screen) never stops or reloads its media
              <iframe
                key={`${t.id}:${t.target}`}
                ref={(el) => {
                  if (el) frameRefs.current.set(t.id, el);
                  else frameRefs.current.delete(t.id);
                }}
                className="nm-surface"
                style={t.id === active.id ? undefined : { display: "none" }}
                src={viewUrl(t.target!)!}
                title="Nekomitai view"
                onLoad={() => onFrameLoad(t.id)}
              />
            ))}
      </div>

      {gateway && (
        <div className="nm-player">
          <div className="nm-player-row">
            <button
              className={`nm-duck${followAE ? " on" : ""}${
                followAE && aeBusy ? " live" : ""
              }`}
              role="switch"
              aria-checked={followAE}
              onClick={() => setFollowAE((v) => !v)}
              title={
                followAE
                  ? "Auto-duck is ON — while you preview in After Effects this reference gets out of the way (playback pauses and keeps your place; it mutes where pausing isn't possible). Click to turn off."
                  : "Auto-duck is OFF — reference audio keeps playing over your After Effects preview. Click to turn on."
              }
            >
              <IconDuck />
              <span className="nm-duck-label">Auto-duck</span>
              <span className="nm-duck-state">{followAE ? "on" : "off"}</span>
            </button>
            <span className="nm-player-status">
              {!followAE
                ? "Reference audio ignores AE playback"
                : aeBusy
                  ? activeDuck === "paused"
                    ? "AE is playing — playback paused"
                    : activeDuck === "muted"
                      ? "AE is playing — sound muted"
                      : "AE is playing"
                  : "Waiting for AE playback"}
            </span>
            <span className="nm-vol-group">
              <span className="nm-vol-icon" title="Reference volume (all tabs)">
                {volume === 0 ? <IconVolumeMuted /> : <IconVolume />}
              </span>
              <input
                className="nm-vol"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setVolume(v);
                  sendAll({ action: "volume", value: v });
                }}
                title="Reference volume (all tabs)"
              />
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

const shortTitle = (url: string) => {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 24);
  }
};
