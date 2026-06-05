"use strict";

const { afterEach, it, mock } = require("node:test");
const assert = require("node:assert");

const initState = require("../src/state");

afterEach(() => {
  mock.restoreAll();
});

function createTheme() {
  return {
    states: {
      idle: ["idle.svg"],
      working: ["working.svg"],
      thinking: ["thinking.svg"],
      juggling: ["juggling.svg"],
      sleeping: ["sleeping.svg"],
    },
    timings: {
      minDisplay: {},
      autoReturn: {},
      deepSleepTimeout: 0,
      yawnDuration: 0,
      wakeDuration: 0,
    },
    hitBoxes: {},
    fileHitBoxes: {},
    displayHintMap: {},
    workingTiers: [
      { minSessions: 1, files: ["juggle.svg", "hula.svg"] },
    ],
  };
}

function createCtx(theme) {
  return {
    theme,
    doNotDisturb: false,
    miniTransitioning: false,
    miniMode: false,
    mouseOverPet: false,
    idlePaused: false,
    playSound() {},
    sendToRenderer() {},
    syncHitWin() {},
    sendToHitWin() {},
    processKill() {
      const err = new Error("ESRCH");
      err.code = "ESRCH";
      throw err;
    },
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    t: (key) => key,
  };
}

function session(state) {
  return {
    state,
    updatedAt: Date.now(),
    headless: false,
  };
}

it("keeps a random tier visual stable until the logical state changes away", () => {
  const api = initState(createCtx(createTheme()));
  const values = [0.9, 0.1, 0.1];
  mock.method(Math, "random", () => values.shift() ?? 0.1);

  try {
    api.sessions.set("s1", session("working"));
    assert.strictEqual(api.getSvgOverride("working"), "hula.svg");
    assert.strictEqual(api.getSvgOverride("working"), "hula.svg");

    api.applyState("working", "hula.svg");
    api.applyState("idle");
    assert.strictEqual(api.getSvgOverride("working"), "juggle.svg");
  } finally {
    api.cleanup();
  }
});
