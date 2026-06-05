"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  classifyApp,
  isDocumentCategory,
  decideAmbientState,
} = require("../src/ambient-classify");

describe("ambient-classify · classifyApp", () => {
  it("classifies editors / documents by bundle id", () => {
    assert.strictEqual(classifyApp({ bundle: "com.microsoft.VSCode", name: "Code" }), "editor");
    assert.strictEqual(classifyApp({ bundle: "com.todesktop.230313mzl4w4u92", name: "Cursor" }), "editor");
    assert.strictEqual(classifyApp({ bundle: "com.apple.dt.Xcode", name: "Xcode" }), "editor");
    assert.strictEqual(classifyApp({ bundle: "com.apple.iWork.Pages", name: "Pages" }), "editor");
    assert.strictEqual(classifyApp({ bundle: "md.obsidian", name: "Obsidian" }), "editor");
    assert.strictEqual(classifyApp({ bundle: "com.microsoft.Word", name: "Microsoft Word" }), "editor");
  });

  it("classifies browsers / terminals / media / chat by bundle id", () => {
    assert.strictEqual(classifyApp({ bundle: "com.google.Chrome", name: "Google Chrome" }), "browser");
    assert.strictEqual(classifyApp({ bundle: "company.thebrowser.Browser", name: "Arc" }), "browser");
    assert.strictEqual(classifyApp({ bundle: "com.apple.Terminal", name: "Terminal" }), "terminal");
    assert.strictEqual(classifyApp({ bundle: "com.googlecode.iterm2", name: "iTerm2" }), "terminal");
    assert.strictEqual(classifyApp({ bundle: "com.spotify.client", name: "Spotify" }), "media");
    assert.strictEqual(classifyApp({ bundle: "com.tinyspeck.slackmacgap", name: "Slack" }), "chat");
  });

  it("falls back to the display name when the bundle id is unknown", () => {
    assert.strictEqual(classifyApp({ bundle: "com.unknown.thing", name: "Sublime Text" }), "editor");
    assert.strictEqual(classifyApp({ bundle: "", name: "Google Chrome" }), "browser");
    assert.strictEqual(classifyApp({ bundle: "", name: "WezTerm" }), "terminal");
  });

  it("classifies Windows executables (frontmost app reports the exe name)", () => {
    // On Windows the foreground reader sets both name and bundle to the exe.
    const win = (exe) => classifyApp({ name: exe, bundle: exe });
    assert.strictEqual(win("Code.exe"), "editor");
    assert.strictEqual(win("Cursor.exe"), "editor");
    assert.strictEqual(win("WINWORD.EXE"), "editor");
    assert.strictEqual(win("devenv.exe"), "editor");
    assert.strictEqual(win("chrome.exe"), "browser");
    assert.strictEqual(win("msedge.exe"), "browser");
    assert.strictEqual(win("WindowsTerminal.exe"), "terminal");
    assert.strictEqual(win("Spotify.exe"), "media");
    assert.strictEqual(win("Discord.exe"), "chat");
    assert.strictEqual(win("explorer.exe"), null); // not a category we react to
  });

  it("returns null for unknown apps and bad input", () => {
    assert.strictEqual(classifyApp({ bundle: "com.foo.bar", name: "Foo" }), null);
    assert.strictEqual(classifyApp(null), null);
    assert.strictEqual(classifyApp({}), null);
  });
});

describe("ambient-classify · isDocumentCategory", () => {
  it("treats editors as documents, but not browsers/terminals/media/chat", () => {
    assert.strictEqual(isDocumentCategory("editor"), true);
    assert.strictEqual(isDocumentCategory("browser"), false);
    assert.strictEqual(isDocumentCategory("terminal"), false);
    assert.strictEqual(isDocumentCategory("media"), false);
    assert.strictEqual(isDocumentCategory("chat"), false);
    assert.strictEqual(isDocumentCategory(null), false);
  });
});

describe("ambient-classify · decideAmbientState", () => {
  it("prioritises typing over music over an open document", () => {
    assert.strictEqual(decideAmbientState({
      userActive: true, typing: true, audioPlaying: true, documentOpen: true,
    }), "working");
    assert.strictEqual(decideAmbientState({
      userActive: true, typing: false, audioPlaying: true, documentOpen: true,
    }), "music");
    assert.strictEqual(decideAmbientState({
      userActive: true, typing: false, audioPlaying: false, documentOpen: true,
    }), "thinking");
  });

  it("releases to idle when nothing is happening", () => {
    assert.strictEqual(decideAmbientState({
      userActive: true, typing: false, audioPlaying: false, documentOpen: false,
    }), null);
  });

  it("releases (lets the pet sleep) when the user is away, even with audio playing", () => {
    assert.strictEqual(decideAmbientState({
      userActive: false, typing: true, audioPlaying: true, documentOpen: true,
    }), null);
  });

  it("tolerates a missing signals object", () => {
    assert.strictEqual(decideAmbientState(), null);
    assert.strictEqual(decideAmbientState({}), null);
  });
});
