"use strict";

// src/ambient-activity.js — Ambient desktop-activity source.
//
// Drives the pet from the USER's own desktop activity when no agent session is
// active ("agent wins, ambient fills gaps"):
//   · typing in any app          → "working"  (calico-working-typing)
//   · music actually playing     → "music"    (calico-music / headphones)
//   · a document open, no typing → "thinking" (calico-thinking)
//
// Detection:
//   · typing = CoreGraphics per-event-type key-down COUNTER via koffi
//              (permission-free; ignores mouse/scroll/clicks).
//   · app    = `lsappinfo` frontmost-app bundle id / name (no a11y prompt).
//   · music  = a real media player (Spotify / Apple Music) reports player state
//              "playing". Reliable: paused/stopped/silent streams and the app's
//              own audio don't count (the per-process CoreAudio "is outputting"
//              signal was true for silent/background streams and even Hikari's
//              own audio, so it falsely danced). One-time macOS Automation grant
//              per player; browser/YouTube audio is intentionally NOT counted to
//              avoid false positives from muted/background tabs.
//
// Scoped to the hikari theme. The state machine (resolveAmbientOverride in
// state.js) arbitrates priority, so this module just decides the ambient state
// and pushes it via ctx.setAmbientState().
// Mirrors the tick.js module shape: initAmbientActivity(ctx) → { start, cleanup }.

const {
  classifyApp,
  isDocumentCategory,
  decideAmbientState,
} = require("./ambient-classify");

let powerMonitor = null;
try { ({ powerMonitor } = require("electron")); } catch { /* tests / non-electron */ }

const { execFile } = require("child_process");

const isMac = process.platform === "darwin";
const DEBUG = !!process.env.CLAWD_AMBIENT_DEBUG; // set CLAWD_AMBIENT_DEBUG=1 to log decisions

// ── Tunables ──
const POLL_MS = 500;            // ambient poll cadence
const FRONT_APP_TTL_MS = 1200;  // frontmost-app cache lifetime (async refresh)
const FRONT_APP_WATCHDOG_MS = 2500; // force-clear a stuck in-flight lookup after this
const AUDIO_TTL_MS = 1000;      // music-state cache lifetime (async osascript probe)
const AUDIO_WATCHDOG_MS = 3000; // force-clear a stuck in-flight music probe after this
const TYPING_WINDOW_MS = 2000;  // a key pressed within this window → "typing"
const THINKING_IDLE_MS = 60000; // document open + active within 60s → thinking
const RELEASE_IDLE_MS = 90000;  // idle longer than this → release (let it sleep)

// Media players queried for real playback. Only ones actually running are asked
// (so nothing is launched), and only "playing" counts.
const MEDIA_APPS = ["Spotify", "Music"];

// Resolve whether any running media player is actively playing. Async; calls
// done(bool). Reliable — paused/stopped don't count, the app's own audio and
// silent background streams are never involved.
function checkMediaPlaying(done) {
  if (!isMac) { done(false); return; }
  let i = 0;
  const nextApp = () => {
    if (i >= MEDIA_APPS.length) { done(false); return; }
    const app = MEDIA_APPS[i++];
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

// Lazily build a "cumulative key-down count" reader via CoreGraphics.
// CGEventSourceCounterForEventType is a permission-free POLL (unlike event taps)
// that counts events of one specific type — kCGEventKeyDown — so mouse moves,
// clicks and scrolling are ignored entirely (those were what used to read as
// "typing"). It returns a uint32, which avoids the floating-point return-value
// ABI mismatch that made the older seconds-based reader misbehave under Electron.
function buildKeyboardReader() {
  if (!isMac) return null;
  let koffi;
  try { koffi = require("koffi"); } catch { return null; }
  try {
    const cg = koffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
    const CGEventSourceCounterForEventType = cg.func(
      "uint32 CGEventSourceCounterForEventType(int32 stateID, uint32 eventType)"
    );
    const HID_STATE = 1; // kCGEventSourceStateHIDSystemState
    const KEY_DOWN = 10; // kCGEventKeyDown
    return {
      keyDownCount() {
        const c = CGEventSourceCounterForEventType(HID_STATE, KEY_DOWN);
        return Number.isFinite(c) ? c : null;
      },
    };
  } catch {
    return null;
  }
}

// Parse `lsappinfo info -only bundleID -only name <asn>` output, e.g.:
//   "CFBundleIdentifier"="com.apple.Terminal"
//   "LSDisplayName"="Terminal"
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
  let running = false;

  let lastPushed = null; // last ambient state we sent (avoid redundant pushes)

  let frontApp = null;
  let frontAppAt = 0;
  let frontAppInFlight = false;
  let frontAppInFlightSince = 0;

  let audioPlaying = false;
  let audioAt = 0;
  let audioInFlight = false;
  let audioInFlightSince = 0;

  let keyboardReader = null;
  let keyboardReaderTried = false;
  let lastKeyCount = null; // previous cumulative key-down count
  let lastKeyDownAt = 0;   // timestamp of the last detected keystroke

  function getIdleMs() {
    if (powerMonitor && typeof powerMonitor.getSystemIdleTime === "function") {
      try { return powerMonitor.getSystemIdleTime() * 1000; } catch { /* fall through */ }
    }
    return 0;
  }

  // Cumulative global key-down count (mouse / scroll / clicks excluded).
  // Returns null when unavailable (non-mac, koffi/CoreGraphics missing) so typing
  // simply never triggers there rather than false-firing on mouse input.
  function getKeyDownCount() {
    if (!keyboardReaderTried) {
      keyboardReaderTried = true;
      keyboardReader = buildKeyboardReader();
    }
    if (!keyboardReader) return null;
    try { return keyboardReader.keyDownCount(); }
    catch { return null; }
  }

  function refreshAudio(now) {
    if (!isMac) { audioPlaying = false; return; }
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
    if (!isMac) return;
    // Watchdog: never get permanently wedged if a lookup's callbacks are lost.
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

    // Transient interaction: while you're dragging her or the context menu is
    // open, leave her current animation ALONE — never yank state mid-drag (that
    // fires hit-cancel-reaction and breaks the drag).
    if (ctx.dragLocked || ctx.menuOpen) {
      scheduleNext();
      return;
    }

    // ── Typing: did the global key-down counter advance since the last poll? ──
    // (mouse moves / scrolls / clicks don't advance the key-down counter)
    const keyCount = getKeyDownCount();
    let keyPressed = false;
    if (keyCount != null) {
      if (lastKeyCount != null && keyCount > lastKeyCount) { lastKeyDownAt = now; keyPressed = true; }
      lastKeyCount = keyCount;
    }
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
      console.log(`[ambient] keyCount=${keyCount} pressed=${keyPressed} typing=${typing} ` +
        `music=${audioPlaying} app=${frontApp ? frontApp.bundle : "?"} cat=${category || "-"} ` +
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
    lastKeyCount = null;
    lastKeyDownAt = 0;
    scheduleNext();
  }

  function cleanup() {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    lastPushed = null;
    lastKeyCount = null;
    lastKeyDownAt = 0;
    frontApp = null;
    frontAppAt = 0;
    frontAppInFlight = false;
    frontAppInFlightSince = 0;
    audioPlaying = false;
    audioAt = 0;
    audioInFlight = false;
    audioInFlightSince = 0;
    // Drop the native keyboard reader so a later start() rebuilds it cleanly.
    keyboardReader = null;
    keyboardReaderTried = false;
  }

  return { start, cleanup };
};

// Exposed for unit tests.
module.exports.parseLsAppInfo = parseLsAppInfo;
