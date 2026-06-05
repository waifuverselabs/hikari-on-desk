"use strict";

// src/ambient-activity.js — Ambient desktop-activity source (macOS + Windows).
//
// Drives the pet from the USER's own desktop activity when no agent session is
// active ("agent wins, ambient fills gaps"):
//   · typing in any app          → "working"  (calico-working-typing)
//   · music actually playing     → "music"    (calico-music / headphones)
//   · a document open, no typing → "thinking" (calico-thinking)
//
// Detection is permission-free and platform-specific, behind a shared poller:
//   typing —
//     macOS:   CoreGraphics per-event-type key-down COUNTER via koffi
//              (CGEventSourceCounterForEventType, kCGEventKeyDown).
//     Windows: GetAsyncKeyState scan of keyboard VKs via koffi (user32).
//   foreground app —
//     macOS:   `lsappinfo` (async).
//     Windows: GetForegroundWindow + QueryFullProcessImageNameW via koffi (sync).
//   music —
//     macOS:   Spotify / Apple Music player state via osascript.
//     Windows: System Media Transport Controls "is playing" via PowerShell
//              (covers Spotify, browser media, any SMTC app).
//
// Every native call is wrapped: if anything is unavailable the reader returns
// null/false and ambient simply does nothing on that platform — never crashes.
// Scoped to the hikari theme; the state machine (resolveAmbientOverride in
// state.js) arbitrates priority. initAmbientActivity(ctx) → { start, cleanup }.

const {
  classifyApp,
  isDocumentCategory,
  decideAmbientState,
} = require("./ambient-classify");

let powerMonitor = null;
try { ({ powerMonitor } = require("electron")); } catch { /* tests / non-electron */ }

const { execFile } = require("child_process");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const DEBUG = !!process.env.CLAWD_AMBIENT_DEBUG; // set CLAWD_AMBIENT_DEBUG=1 to log decisions

// ── Tunables ──
const POLL_MS = 500;            // ambient poll cadence
const FRONT_APP_TTL_MS = 1200;  // frontmost-app cache lifetime
const FRONT_APP_WATCHDOG_MS = 2500; // force-clear a stuck async lookup after this
const AUDIO_TTL_MS = 1000;      // music-state cache lifetime
const AUDIO_WATCHDOG_MS = 3000; // force-clear a stuck async music probe after this
const TYPING_WINDOW_MS = 2000;  // a key pressed within this window → "typing"
const WIN_KEYBOARD_POLL_MS = 120; // Windows: sample the keyboard faster than the main poll to catch taps
const THINKING_IDLE_MS = 60000; // document open + active within 60s → thinking
const RELEASE_IDLE_MS = 90000;  // idle longer than this → release (let it sleep)

// ───────────────────────── typing readers ─────────────────────────
// Each reader exposes pressedSinceLast(): true if a key was pressed since the
// previous call. Returns null when unavailable so typing never false-fires.

// macOS — CoreGraphics cumulative key-down counter (delta = a key was pressed).
function buildKeyboardReaderMac() {
  let koffi;
  try { koffi = require("koffi"); } catch { return null; }
  try {
    const cg = koffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
    const CGEventSourceCounterForEventType = cg.func(
      "uint32 CGEventSourceCounterForEventType(int32 stateID, uint32 eventType)"
    );
    const HID_STATE = 1; // kCGEventSourceStateHIDSystemState
    const KEY_DOWN = 10; // kCGEventKeyDown
    let last = null;
    return {
      pressedSinceLast() {
        const c = CGEventSourceCounterForEventType(HID_STATE, KEY_DOWN);
        if (!Number.isFinite(c)) return false;
        const pressed = last != null && c > last;
        last = c;
        return pressed;
      },
    };
  } catch {
    return null;
  }
}

// Windows VKs to ignore when scanning for "typing": mouse buttons, modifiers,
// lock keys, and media/browser/volume keys (none of which are real typing —
// this mirrors macOS kCGEventKeyDown, which excludes modifiers/media events).
const WIN_SKIP_VK = (() => {
  const s = new Set([0x10, 0x11, 0x12, 0x14, 0x5b, 0x5c, 0x90, 0x91]);
  for (let vk = 0xa0; vk <= 0xb7; vk += 1) s.add(vk); // L/R modifiers + browser/media/volume
  return s;
})();

// Windows — scan keyboard VKs via GetAsyncKeyState. The 0x8000 bit = currently
// down; the 0x0001 bit = pressed since the previous call. Either means activity.
function buildKeyboardReaderWin() {
  let koffi;
  try { koffi = require("koffi"); } catch { return null; }
  try {
    const user32 = koffi.load("user32.dll");
    const GetAsyncKeyState = user32.func("int16 __stdcall GetAsyncKeyState(int vKey)");
    return {
      pressedSinceLast() {
        for (let vk = 0x08; vk <= 0xfe; vk += 1) {
          if (WIN_SKIP_VK.has(vk)) continue;
          // 0x8000 = currently down (returned as a negative int16 — mask to 16
          // bits first); 0x0001 = pressed since the previous call.
          if (((GetAsyncKeyState(vk) & 0xffff) & 0x8001) !== 0) return true;
        }
        return false;
      },
    };
  } catch {
    return null;
  }
}

function buildKeyboardReader() {
  if (isMac) return buildKeyboardReaderMac();
  if (isWin) return buildKeyboardReaderWin();
  return null;
}

// ───────────────────────── foreground-app readers ─────────────────────────
// Windows reader is synchronous (fast koffi calls); macOS uses async lsappinfo
// (handled separately in refreshFrontApp).

const WIN_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

function buildForegroundReaderWin() {
  let koffi;
  try { koffi = require("koffi"); } catch { return null; }
  try {
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    const GetForegroundWindow = user32.func("void* __stdcall GetForegroundWindow()");
    const GetWindowThreadProcessId = user32.func(
      "uint32 __stdcall GetWindowThreadProcessId(void* hWnd, _Out_ uint32* lpdwProcessId)"
    );
    const OpenProcess = kernel32.func(
      "void* __stdcall OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)"
    );
    // lpExeName is declared void* (not _Out_ uint16*) so koffi accepts a Node
    // Buffer as the output pointer; lpdwSize is an _Inout_ count (in: capacity
    // in wchars, out: wchars written).
    const QueryFullProcessImageNameW = kernel32.func(
      "int __stdcall QueryFullProcessImageNameW(void* hProcess, uint32 dwFlags, void* lpExeName, _Inout_ uint32* lpdwSize)"
    );
    const CloseHandle = kernel32.func("int __stdcall CloseHandle(void* hObject)");

    const PATH_CAP = 1024; // wchars — covers any real exe path (the API can return up to 32767)
    const pathBuf = Buffer.alloc(PATH_CAP * 2); // reused across calls

    return {
      current() {
        const hwnd = GetForegroundWindow();
        if (!hwnd) return null;
        const pidOut = [0];
        GetWindowThreadProcessId(hwnd, pidOut);
        const pid = pidOut[0] | 0;
        if (!pid) return null;
        const hProc = OpenProcess(WIN_PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if (!hProc) return null;
        try {
          const size = [PATH_CAP];
          const ok = QueryFullProcessImageNameW(hProc, 0, pathBuf, size);
          if (!ok) return null;
          const chars = Math.max(0, Math.min(PATH_CAP, size[0] | 0));
          const full = pathBuf.toString("utf16le", 0, chars * 2);
          const exe = full.split(/[\\/]/).pop();
          if (!exe) return null;
          return { name: exe, bundle: exe };
        } finally {
          try { CloseHandle(hProc); } catch { /* ignore */ }
        }
      },
    };
  } catch {
    return null;
  }
}

// ───────────────────────── music detection ─────────────────────────

// macOS: query running media players for actual "playing" state via osascript.
const MAC_MEDIA_APPS = ["Spotify", "Music"];

function checkMediaPlayingMac(done) {
  let i = 0;
  const nextApp = () => {
    if (i >= MAC_MEDIA_APPS.length) { done(false); return; }
    const app = MAC_MEDIA_APPS[i++];
    execFile("pgrep", ["-x", app], { timeout: 600 }, (err, out) => {
      if (err || !String(out).trim()) { nextApp(); return; } // not running → skip
      execFile(
        "osascript",
        ["-e", `tell application "${app}" to player state`],
        { timeout: 900 },
        (err2, out2) => {
          if (!err2 && String(out2).trim() === "playing") { done(true); return; }
          nextApp();
        }
      );
    });
  };
  nextApp();
}

// Windows: System Media Transport Controls — is any session actively Playing?
// (PlaybackStatus enum: 4 = Playing.) Covers Spotify, Edge/Chrome media, etc.
const WIN_SMTC_TYPE = "Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager";
const WIN_SMTC_PS = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$p='NO'",
  "try{",
  "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
  `$null=[${WIN_SMTC_TYPE},Windows.Media.Control,ContentType=WindowsRuntime]`,
  "$g=([System.WindowsRuntimeSystemExtensions].GetMethods()|?{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'})[0]",
  "if($g){",
  `$at=$g.MakeGenericMethod([${WIN_SMTC_TYPE}])`,
  `$nt=$at.Invoke($null,@([${WIN_SMTC_TYPE}]::RequestAsync()))`,
  "$nt.Wait(2000)|Out-Null",
  "$mgr=$nt.Result",
  "if($mgr){foreach($s in $mgr.GetSessions()){$i=$s.GetPlaybackInfo();if($i -ne $null -and $i.PlaybackStatus -ne $null -and ([int]$i.PlaybackStatus) -eq 4){$p='PLAYING';break}}}",
  "}",
  "}catch{}",
  "Write-Output $p",
].join("\n");
// PowerShell -EncodedCommand expects BOM-less UTF-16LE base64.
const WIN_SMTC_B64 = Buffer.from(WIN_SMTC_PS, "utf16le").toString("base64");

function checkMediaPlayingWin(done) {
  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", WIN_SMTC_B64],
    { timeout: 2800, windowsHide: true }, // < AUDIO_WATCHDOG_MS so a stuck probe is killed first
    (err, out) => {
      if (err) { done(false); return; }
      done(String(out).trim().toUpperCase().includes("PLAYING"));
    }
  );
}

function checkMediaPlaying(done) {
  if (isMac) return checkMediaPlayingMac(done);
  if (isWin) return checkMediaPlayingWin(done);
  return done(false);
}

// Parse `lsappinfo info -only bundleID -only name <asn>` output (macOS).
function parseLsAppInfo(text) {
  let name = null;
  let bundle = null;
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/"([^"]+)"\s*=\s*"([^"]*)"/);
    if (!m) continue;
    if (m[1] === "CFBundleIdentifier") bundle = m[2];
    else if (m[1] === "LSDisplayName") name = m[2];
  }
  if (!name && !bundle) return null;
  return { name, bundle };
}

module.exports = function initAmbientActivity(ctx) {
  let timer = null;
  let keyboardTimer = null; // Windows-only fast keyboard sampler
  let running = false;

  let lastPushed = null;  // last ambient state we sent
  let lastKeyDownAt = 0;  // timestamp of the last detected keystroke

  let frontApp = null;
  let frontAppAt = 0;
  let frontAppInFlight = false;     // macOS async lookup guard
  let frontAppInFlightSince = 0;

  let audioPlaying = false;
  let audioAt = 0;
  let audioInFlight = false;
  let audioInFlightSince = 0;

  let keyboardReader = null;
  let keyboardReaderTried = false;
  let fgReader = null;             // Windows synchronous foreground reader
  let fgReaderTried = false;

  function getIdleMs() {
    if (powerMonitor && typeof powerMonitor.getSystemIdleTime === "function") {
      try { return powerMonitor.getSystemIdleTime() * 1000; } catch { /* fall through */ }
    }
    return 0;
  }

  // True if a key was pressed since the last poll (mac counter delta / Windows
  // GetAsyncKeyState scan). No reader (other platforms) → never typing.
  function sampleKeyPressed() {
    if (!keyboardReaderTried) {
      keyboardReaderTried = true;
      keyboardReader = buildKeyboardReader();
    }
    if (!keyboardReader) return false;
    try { return keyboardReader.pressedSinceLast() === true; }
    catch { return false; }
  }

  function refreshAudio(now) {
    if (!isMac && !isWin) { audioPlaying = false; return; }
    if (audioInFlight) {
      if (now - audioInFlightSince > AUDIO_WATCHDOG_MS) audioInFlight = false;
      else return;
    }
    if (now - audioAt < AUDIO_TTL_MS) return;
    audioInFlight = true;
    audioInFlightSince = now;
    checkMediaPlaying((playing) => {
      audioInFlight = false;
      audioAt = Date.now();
      audioPlaying = playing === true;
    });
  }

  function refreshFrontApp(now) {
    if (isWin) {
      // Synchronous read via koffi, cached on a TTL.
      if (now - frontAppAt < FRONT_APP_TTL_MS) return;
      if (!fgReaderTried) { fgReaderTried = true; fgReader = buildForegroundReaderWin(); }
      frontAppAt = now;
      if (!fgReader) return;
      try {
        const app = fgReader.current();
        if (app) frontApp = app;
      } catch (e) { if (DEBUG) console.log("[ambient] win fg read error:", e && e.message); }
      return;
    }
    if (!isMac) return;
    // macOS: async lsappinfo with a watchdog so a lost callback can't wedge us.
    if (frontAppInFlight) {
      if (now - frontAppInFlightSince > FRONT_APP_WATCHDOG_MS) frontAppInFlight = false;
      else return;
    }
    if (now - frontAppAt < FRONT_APP_TTL_MS) return;
    frontAppInFlight = true;
    frontAppInFlightSince = now;
    execFile("lsappinfo", ["front"], { timeout: 700 }, (err1, asnOut) => {
      const asn = String(asnOut || "").trim();
      if (err1 || !asn) {
        frontAppInFlight = false;
        frontAppAt = Date.now();
        return;
      }
      execFile(
        "lsappinfo",
        ["info", "-only", "bundleID", "-only", "name", asn],
        { timeout: 700 },
        (err2, infoOut) => {
          frontAppInFlight = false;
          frontAppAt = Date.now();
          if (err2 || !infoOut) return;
          const parsed = parseLsAppInfo(infoOut);
          if (parsed) frontApp = parsed;
        }
      );
    });
  }

  // Hard-off conditions → release ambient (let agent/idle/sleep take over).
  function gatesOpen() {
    if (!ctx.enabled) return false;
    if (!ctx.isHikari) return false;
    if (ctx.doNotDisturb) return false;
    if (ctx.miniMode) return false;
    return true;
  }

  function push(state) {
    const next = state || null;
    if (next === lastPushed) return;
    lastPushed = next;
    try { ctx.setAmbientState(next); } catch { /* state module owns errors */ }
  }

  function poll() {
    if (!running) return;
    const now = Date.now();

    if (!gatesOpen()) {
      push(null);
      scheduleNext();
      return;
    }

    // Transient interaction: don't yank state mid-drag or while the menu is open.
    if (ctx.dragLocked || ctx.menuOpen) {
      scheduleNext();
      return;
    }

    // ── Typing: a real key pressed within the window (mouse/scroll excluded) ──
    // macOS samples here (the CoreGraphics counter is reliable point-to-point);
    // Windows samples in a faster dedicated timer so quick taps aren't missed.
    if (!isWin && sampleKeyPressed()) lastKeyDownAt = now;
    const typing = lastKeyDownAt > 0 && now - lastKeyDownAt < TYPING_WINDOW_MS;

    // ── Music + frontmost app (cached / async) ──
    const idleMs = getIdleMs();
    refreshAudio(now);
    refreshFrontApp(now);
    const category = classifyApp(frontApp);
    const documentOpen = isDocumentCategory(category) && idleMs < THINKING_IDLE_MS;

    const next = decideAmbientState({
      userActive: idleMs < RELEASE_IDLE_MS,
      typing,
      audioPlaying,
      documentOpen,
    });

    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`[ambient] typing=${typing} music=${audioPlaying} ` +
        `app=${frontApp ? frontApp.bundle : "?"} cat=${category || "-"} ` +
        `doc=${documentOpen} -> ${next || "idle"}`);
    }

    push(next);
    scheduleNext();
  }

  function scheduleNext() {
    if (!running) return;
    timer = setTimeout(poll, POLL_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function start() {
    if (running) return;
    running = true;
    lastKeyDownAt = 0;
    if (isWin) {
      // GetAsyncKeyState is point-in-time, so sample faster than the 500ms main
      // poll to reliably catch quick key taps. Cheap (koffi calls only); gated so
      // we don't scan when ambient is off.
      keyboardTimer = setInterval(() => {
        if (!running || !ctx.enabled || !ctx.isHikari) return;
        if (sampleKeyPressed()) lastKeyDownAt = Date.now();
      }, WIN_KEYBOARD_POLL_MS);
      if (keyboardTimer && typeof keyboardTimer.unref === "function") keyboardTimer.unref();
    }
    scheduleNext();
  }

  function cleanup() {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (keyboardTimer) { clearInterval(keyboardTimer); keyboardTimer = null; }
    lastPushed = null;
    lastKeyDownAt = 0;
    frontApp = null;
    frontAppAt = 0;
    frontAppInFlight = false;
    frontAppInFlightSince = 0;
    audioPlaying = false;
    audioAt = 0;
    audioInFlight = false;
    audioInFlightSince = 0;
    keyboardReader = null;
    keyboardReaderTried = false;
    fgReader = null;
    fgReaderTried = false;
  }

  return { start, cleanup };
};

// Exposed for unit tests.
module.exports.parseLsAppInfo = parseLsAppInfo;
