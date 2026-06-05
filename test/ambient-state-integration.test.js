// test/ambient-state-integration.test.js — verifies src/state.js setAmbientState()
// integrates with resolveDisplayState() against the real hikari theme:
// ambient fills the gap only when no agent session is active (agent wins),
// and Do Not Disturb suppresses it entirely.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));
const hikari = themeLoader.loadTheme("hikari");
const { createTranslator } = require("../src/i18n");
const initState = require("../src/state");

function makeCtx(overrides = {}) {
  const ctx = {
    lang: "en",
    theme: hikari,
    doNotDisturb: false,
    miniTransitioning: false,
    miniMode: false,
    mouseOverPet: false,
    idlePaused: false,
    forceEyeResend: false,
    eyePauseUntil: 0,
    mouseStillSince: Date.now(),
    miniSleepPeeked: false,
    playSound: () => {},
    sendToRenderer: () => {},
    syncHitWin: () => {},
    sendToHitWin: () => {},
    flashTaskbar: () => {},
    miniPeekIn: () => {},
    miniPeekOut: () => {},
    dismissPermissionsForDnd: () => {},
    processKill: () => { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; },
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    ...overrides,
  };
  ctx.t = createTranslator(() => ctx.lang);
  return ctx;
}

describe("ambient state integration (state.js · me-first)", () => {
  it("surfaces ambient states (working/music/thinking) when no agent is active and releases to idle", () => {
    const ctx = makeCtx();
    const api = initState(ctx);
    try {
      assert.strictEqual(api.getCurrentState(), "idle");

      api.setAmbientState("working");
      assert.strictEqual(api.getCurrentState(), "working");

      api.setAmbientState("music");
      assert.strictEqual(api.getCurrentState(), "music");

      api.setAmbientState("thinking");
      assert.strictEqual(api.getCurrentState(), "thinking");

      api.setAmbientState(null);
      assert.strictEqual(api.getCurrentState(), "idle");
    } finally {
      api.cleanup();
    }
  });

  it("ACTIVE ambient (your typing / audio) overrides a working agent session", () => {
    const ctx = makeCtx();
    const api = initState(ctx);
    try {
      // Agent is working...
      api.updateSession("s1", "working", "PreToolUse", { agentId: "claude-code" });
      assert.strictEqual(api.getCurrentState(), "working");

      // ...but you start typing → your typing wins (still "working" state, but
      // sourced from ambient with the base typing art).
      api.setAmbientState("working");
      assert.strictEqual(api.getCurrentState(), "working");
      // Audio likewise overrides the agent → dancing.
      api.setAmbientState("music");
      assert.strictEqual(api.getCurrentState(), "music");

      // You stop → agent fills the gap again.
      api.setAmbientState(null);
      assert.strictEqual(api.getCurrentState(), "working");
    } finally {
      api.cleanup();
    }
  });

  it("PASSIVE ambient (doc-open thinking) only fills the gap when the agent is idle", () => {
    const ctx = makeCtx();
    const api = initState(ctx);
    try {
      // Agent working + you're just reading a document → agent shows (passive
      // ambient does NOT override).
      api.updateSession("s1", "working", "PreToolUse", { agentId: "claude-code" });
      api.setAmbientState("thinking");
      assert.strictEqual(api.getDisplayTarget(), "working");

      // Agent goes idle → passive ambient fills the gap.
      api.updateSession("s1", "idle", "SessionEnd", { agentId: "claude-code" });
      assert.strictEqual(api.getDisplayTarget(), "thinking");
    } finally {
      api.cleanup();
    }
  });

  it("suppresses ambient under Do Not Disturb", () => {
    const ctx = makeCtx({ doNotDisturb: true });
    const api = initState(ctx);
    try {
      api.setAmbientState("music");
      assert.notStrictEqual(api.getCurrentState(), "music");
    } finally {
      api.cleanup();
    }
  });
});
