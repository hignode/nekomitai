/**
 * AE audio-activity meter — a PowerShell sidecar sampling the Windows
 * (WASAPI) per-application audio peak meter for the AfterFX process.
 *
 * RAM/spacebar preview is invisible to scripting (comp.time freezes and
 * evalScript still answers), but a preview WITH audio makes AfterFX's audio
 * session peak rise — a direct "AE is playing" signal. The reference video's
 * own sound can't feed back into it: CEP pages emit audio from
 * CEPHtmlEngine.exe, a different process, and the meter matches AfterFX PIDs
 * only.
 *
 * ON DEMAND, not persistent: the sidecar spawns on the first /aepeak query
 * and is killed after 5 idle minutes — the panel only polls /aepeak while a
 * tab is audibly playing, so an idle panel keeps zero background processes
 * sampling COM. The first query after a cold stop reads 0 for the second or
 * two the sidecar takes to compile its C# shim; the duck watchdog holds ALL
 * ExtendScript until the first sample lands (see Browser.tsx's safeForES).
 * Because that makes the sidecar a hard gate, a meter that has given up
 * (PowerShell blocked by policy, repeated crashes) is reported as `dead` so
 * the watchdog can fall back to grace-gated ExtendScript instead of going
 * silently inert; a cold retry every 10 minutes probes for recovery.
 *
 * All probes are scoped to the HOST AfterFX instance when it can be found
 * (CEPHtmlEngine's parent process) — another AE instance's audio, dialogs,
 * or blocked UI thread must not steer this panel.
 *
 * The sidecar also reports whether a MODAL DIALOG is up in AfterFX (any
 * visible top-level AfterFX window that Windows has disabled — a modal always
 * disables its owner). While a modal is up, EVERY evalScript is refused with
 * an "Unable to execute script…" alert AE shows to the user, so the duck
 * watchdog uses this flag to hold all ExtendScript traffic until the dialog
 * closes. `modal: null` means "no fresh sample" (cold start, non-Windows) —
 * callers must treat that as unknown, not as "no modal".
 *
 * It also reports whether AfterFX's UI thread is currently ANSWERING
 * (SendMessageTimeout WM_NULL). Opening or closing a project blocks AE's main
 * thread for seconds with no modal up yet; an evalScript issued into that
 * block sits queued until AE services it — frequently at the exact moment a
 * load-time dialog (missing footage, "saved in a newer version") has
 * appeared, turning the queued call into the same refusal alert. `busy` warns
 * the watchdog off before the call is ever issued; like `modal`, null means
 * unknown.
 */
import { child_process } from "../cep/node";

let child: ReturnType<typeof child_process.spawn> | null = null;
let last = { peak: 0, modal: false, busy: false, at: 0 };
let failures = 0;
let gaveUp = false; // 6 spawns died without a single parsed sample
let gaveUpAt = 0;
let retryScheduled = false;
let stopping = false; // deliberate idle shutdown in flight — not a failure
let lastQuery = 0;
let idleTimer: ReturnType<typeof setInterval> | null = null;

const IDLE_STOP_MS = 5 * 60_000; // no /aepeak query this long → stop sampling
const RETRY_COLD_MS = 10 * 60_000; // after giving up, probe again this often

// Prints "P <peak> <modal01> <busy01>" (invariant-culture float) every 80ms
// (plus up to the WM_NULL timeout while AE's UI thread is blocked); exits
// when the parent pipe closes so reloads never accumulate orphan sidecars.
const PS_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace NMAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumeratorCom { }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints_(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
      [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }
  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionManager2 {
    int GetAudioSessionControl_(IntPtr guid, int flags, out IntPtr control);
    int GetSimpleAudioVolume_(IntPtr guid, int flags, out IntPtr volume);
    int GetSessionEnumerator(out IAudioSessionEnumerator enumerator);
  }
  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionEnumerator {
    int GetCount(out int count);
    int GetSession(int index, out IAudioSessionControl session);
  }
  [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionControl {
    int GetState(out int state);
  }
  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionControl2 {
    int GetState_(out int state);
    int GetDisplayName_([MarshalAs(UnmanagedType.LPWStr)] out string name);
    int SetDisplayName_([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr ctx);
    int GetIconPath_([MarshalAs(UnmanagedType.LPWStr)] out string path);
    int SetIconPath_([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr ctx);
    int GetGroupingParam_(out Guid param);
    int SetGroupingParam_(ref Guid param, IntPtr ctx);
    int NotifyRegister_(IntPtr notifications);
    int NotifyUnregister_(IntPtr notifications);
    int GetSessionIdentifier_([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetSessionInstanceIdentifier_([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetProcessId(out uint pid);
  }
  [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioMeterInformation {
    int GetPeakValue(out float peak);
  }
  public static class Modal {
    delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lparam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
    static uint[] pidsNow; static bool found;
    // A modal dialog always disables its owner, so "any visible top-level
    // AfterFX window that is disabled" == "a modal dialog is waiting".
    public static bool UpForPids(uint[] pids) {
      pidsNow = pids; found = false;
      EnumWindows(Check, IntPtr.Zero);
      return found;
    }
    static bool Check(IntPtr hwnd, IntPtr l) {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      bool match = false;
      for (int j = 0; j < pidsNow.Length; j++) if (pidsNow[j] == pid) match = true;
      if (match && IsWindowVisible(hwnd) && !IsWindowEnabled(hwnd)) { found = true; return false; }
      return true;
    }
  }
  public static class Busy {
    delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lparam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out IntPtr result);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    static uint pidWanted; static IntPtr best; static long bestArea;
    // Find AE's main window ourselves rather than trusting .NET's
    // MainWindowHandle, and probe ONLY that one: it belongs to the main UI
    // thread, the same thread ExtendScript runs on. Scanning every window
    // instead would let one plugin's non-pumping worker-thread window latch
    // "blocked" forever. Selection uses only non-messaging calls (a
    // GetWindowText here would itself hang on a hung window): visible,
    // unowned, largest by area.
    public static IntPtr MainWindow(uint pid) {
      pidWanted = pid; best = IntPtr.Zero; bestArea = -1;
      EnumWindows(Pick, IntPtr.Zero);
      return best;
    }
    static bool Pick(IntPtr hwnd, IntPtr l) {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pid != pidWanted || !IsWindowVisible(hwnd)) return true;
      if (GetWindow(hwnd, 4) != IntPtr.Zero) return true; // GW_OWNER — skip dialogs
      RECT r;
      if (!GetWindowRect(hwnd, out r)) return true;
      long area = (long)(r.R - r.L) * (long)(r.B - r.T);
      if (area > bestArea) { bestArea = area; best = hwnd; }
      return true;
    }
    // Two signals, because they cover different durations. IsHungAppWindow is
    // what Windows itself uses to paint "Not Responding" — free, no waiting,
    // but it only trips after ~5s of a starved message pump. WM_NULL is a
    // no-op a healthy UI thread answers instantly, so a 400ms timeout catches
    // the shorter blocks; it is generous enough that RAM-preview frame
    // hitches don't read as "blocked". 0x0008 = SMTO_ABORTIFHUNG so an
    // already-hung thread returns at once instead of burning the timeout.
    // ONLY ERROR_TIMEOUT counts: any other failure (window destroyed mid-
    // probe, invalid handle) is not evidence of a blocked UI.
    public static bool Blocked(IntPtr hwnd) {
      if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return false;
      if (IsHungAppWindow(hwnd)) return true;
      IntPtr res;
      if (SendMessageTimeout(hwnd, 0, IntPtr.Zero, IntPtr.Zero, 0x0008, 400, out res) == IntPtr.Zero) {
        return Marshal.GetLastWin32Error() == 1460 && IsWindow(hwnd); // ERROR_TIMEOUT
      }
      return false;
    }
    public static bool Alive(IntPtr hwnd) {
      return hwnd != IntPtr.Zero && IsWindow(hwnd);
    }
  }
  public static class Meter {
    public static float PeakForPids(uint[] pids) {
      float max = 0f;
      var enumerator = (IMMDeviceEnumerator)(object)new MMDeviceEnumeratorCom();
      IMMDevice device;
      enumerator.GetDefaultAudioEndpoint(0, 1, out device);
      var iidMgr = typeof(IAudioSessionManager2).GUID;
      object mgrObj;
      device.Activate(ref iidMgr, 0x17, IntPtr.Zero, out mgrObj);
      var mgr = (IAudioSessionManager2)mgrObj;
      IAudioSessionEnumerator sessions;
      mgr.GetSessionEnumerator(out sessions);
      int count;
      sessions.GetCount(out count);
      for (int i = 0; i < count; i++) {
        IAudioSessionControl session;
        sessions.GetSession(i, out session);
        var s2 = (IAudioSessionControl2)session;
        uint pid;
        s2.GetProcessId(out pid);
        bool match = false;
        for (int j = 0; j < pids.Length; j++) if (pids[j] == pid) match = true;
        if (!match) continue;
        var meterObj = session as IAudioMeterInformation;
        if (meterObj != null) {
          float peak;
          meterObj.GetPeakValue(out peak);
          if (peak > max) max = peak;
        }
      }
      return max;
    }
  }
}
"@
$pids = @()
$hostPid = [uint32]${process.ppid || 0}
$mainHwnd = [IntPtr]::Zero
$i = 0
$inv = [System.Globalization.CultureInfo]::InvariantCulture
while ($true) {
  if ($i % 60 -eq 0 -or (($i % 12) -eq 0 -and -not [NMAudio.Busy]::Alive($mainHwnd))) {
    $pids = @(Get-Process -Name AfterFX -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
    if ($hostPid -gt 0 -and $pids -contains $hostPid) { $pids = @($hostPid) }
    $mainHwnd = [IntPtr]::Zero
    if ($pids.Count -gt 0) {
      try { $mainHwnd = [NMAudio.Busy]::MainWindow([uint32]$pids[0]) } catch { }
    }
  }
  $i++
  $peak = 0.0
  $modal = 0
  $busy = 0
  if ($pids.Count -gt 0) {
    try { $peak = [NMAudio.Meter]::PeakForPids([uint32[]]$pids) } catch { $peak = 0.0 }
    try { if ([NMAudio.Modal]::UpForPids([uint32[]]$pids)) { $modal = 1 } } catch { $modal = 0 }
    try { if ([NMAudio.Busy]::Blocked($mainHwnd)) { $busy = 1 } } catch { $busy = 0 }
  }
  try { [Console]::Out.WriteLine("P " + $peak.ToString("0.0000", $inv) + " " + $modal + " " + $busy) } catch { exit }
  Start-Sleep -Milliseconds 80
}
`;

const spawnMeter = (): void => {
  try {
    const enc = Buffer.from(PS_SCRIPT, "utf16le").toString("base64");
    const p = child_process.spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
    );
    child = p;
    let buf = "";
    p.stdout?.on("data", (c) => {
      buf += String(c);
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("P ")) {
          const parts = line.slice(2).split(" ");
          const v = parseFloat(parts[0]);
          if (isFinite(v)) {
            last = {
              peak: v,
              modal: parts[1] === "1",
              busy: parts[2] === "1",
              at: Date.now(),
            };
            failures = 0;
            gaveUp = false;
          }
        }
      }
    });
    p.on("error", onExit);
    p.on("exit", onExit);
  } catch {
    onExit();
  }
};

const onExit = (): void => {
  child = null;
  if (stopping) {
    stopping = false; // we asked it to stop — nothing to retry
    return;
  }
  if (retryScheduled) return;
  retryScheduled = true;
  failures++;
  if (failures > 5) {
    // give up — /aepeak reports dead so the watchdog can fall back, and
    // ensureRunning probes again after a long cool-off
    gaveUp = true;
    gaveUpAt = Date.now();
    retryScheduled = false;
    return;
  }
  setTimeout(() => {
    retryScheduled = false;
    // only respawn if something is still asking for peaks
    if (Date.now() - lastQuery < IDLE_STOP_MS) spawnMeter();
  }, 3000);
};

const ensureRunning = (): void => {
  if (process.platform !== "win32") return;
  if (!child && !retryScheduled) {
    if (failures <= 5) spawnMeter();
    else if (Date.now() - gaveUpAt > RETRY_COLD_MS) {
      failures = 0;
      gaveUpAt = Date.now();
      spawnMeter();
    }
  }
  if (!idleTimer) {
    idleTimer = setInterval(() => {
      if (Date.now() - lastQuery <= IDLE_STOP_MS) return;
      if (idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
      if (child) {
        stopping = true;
        try {
          child.kill();
        } catch {
          stopping = false;
        }
      }
    }, 60_000);
  }
};

/** Latest AfterFX audio peak (0..1), modal-dialog flag, and UI-thread-blocked
 * flag; stale samples read as silence / unknown. `dead` marks a meter that
 * has given up entirely (PowerShell blocked, repeated crashes) — the duck
 * watchdog needs to distinguish "no sample YET" (hold ExtendScript) from "no
 * sample EVER" (fall back or auto-duck goes silently inert). Querying is what
 * keeps the sidecar alive — see the header comment. */
export const getAePeak = (): {
  peak: number;
  at: number;
  alive: boolean;
  modal: boolean | null;
  busy: boolean | null;
  dead: boolean;
} => {
  lastQuery = Date.now();
  ensureRunning();
  const fresh = Date.now() - last.at < 2000;
  return {
    peak: fresh ? last.peak : 0,
    at: last.at,
    alive: fresh,
    modal: fresh ? last.modal : null,
    busy: fresh ? last.busy : null,
    dead: process.platform === "win32" && gaveUp && !fresh,
  };
};
