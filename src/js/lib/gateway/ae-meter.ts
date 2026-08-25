/**
 * AE audio-activity meter — a persistent PowerShell sidecar sampling the
 * Windows (WASAPI) per-application audio peak meter for the AfterFX process.
 *
 * RAM/spacebar preview is invisible to scripting (comp.time freezes and
 * evalScript still answers), but a preview WITH audio makes AfterFX's audio
 * session peak rise — a direct "AE is playing" signal. The reference video's
 * own sound can't feed back into it: CEP pages emit audio from
 * CEPHtmlEngine.exe, a different process, and the meter matches AfterFX PIDs
 * only.
 */
import { child_process } from "../cep/node";

let last = { peak: 0, at: 0 };
let started = false;
let failures = 0;
let retryScheduled = false;

// Prints "P <peak>" (invariant-culture float) every 80ms; exits when the
// parent pipe closes so reloads never accumulate orphan sidecars.
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
$i = 0
$inv = [System.Globalization.CultureInfo]::InvariantCulture
while ($true) {
  if ($i % 60 -eq 0) {
    $pids = @(Get-Process -Name AfterFX -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  }
  $i++
  $peak = 0.0
  if ($pids.Count -gt 0) {
    try { $peak = [NMAudio.Meter]::PeakForPids([uint32[]]$pids) } catch { $peak = 0.0 }
  }
  try { [Console]::Out.WriteLine("P " + $peak.ToString("0.0000", $inv)) } catch { exit }
  Start-Sleep -Milliseconds 80
}
`;

export const startAeMeter = (): void => {
  if (started || process.platform !== "win32") return;
  started = true;
  spawnMeter();
};

const spawnMeter = (): void => {
  try {
    const enc = Buffer.from(PS_SCRIPT, "utf16le").toString("base64");
    const p = child_process.spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
    );
    let buf = "";
    p.stdout?.on("data", (c) => {
      buf += String(c);
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("P ")) {
          const v = parseFloat(line.slice(2));
          if (isFinite(v)) {
            last = { peak: v, at: Date.now() };
            failures = 0;
          }
        }
      }
    });
    p.on("error", retry);
    p.on("exit", retry);
  } catch {
    retry();
  }
};

const retry = (): void => {
  if (retryScheduled) return;
  retryScheduled = true;
  failures++;
  if (failures > 5) return; // give up quietly — /aepeak just reports 0
  setTimeout(() => {
    retryScheduled = false;
    spawnMeter();
  }, 3000);
};

/** Latest AfterFX audio peak (0..1); stale samples read as silence. */
export const getAePeak = (): { peak: number; at: number; alive: boolean } => {
  const fresh = Date.now() - last.at < 2000;
  return { peak: fresh ? last.peak : 0, at: last.at, alive: fresh };
};
