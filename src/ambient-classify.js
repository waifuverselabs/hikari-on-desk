"use strict";

// src/ambient-classify.js — pure helpers for the ambient desktop-activity
// source. No Electron / FS / native deps so it is unit-testable in isolation.
//
// classifyApp({ name, bundle }) → 'editor' | 'browser' | 'terminal' | 'media'
//                                 | 'chat' | null
// decideAmbientState(signals)   → 'working' | 'music' | 'thinking' | null
//
// Categories are matched against the lowercased macOS bundle identifier first
// (reliable), then the lowercased display name as a fallback (best-effort).

const CATEGORY_BUNDLE_TOKENS = {
  editor: [
    "com.microsoft.vscode", "com.vscodium", "com.todesktop", // VS Code / VSCodium / Cursor
    "com.sublimetext", "dev.zed.zed", "com.jetbrains", "com.google.android.studio",
    "com.apple.dt.xcode", "com.apple.textedit", "com.apple.notes", "com.apple.preview",
    "com.apple.iwork", "com.apple.ibooksx", "com.microsoft.word", "com.microsoft.powerpoint",
    "com.microsoft.excel", "com.microsoft.onenote", "md.obsidian", "notion.id", "com.notion",
    "abnerworks.typora", "com.typora", "net.ia.writer", "pro.writer.mac", "com.coteditor.coteditor",
    "com.uranusjr.macdown", "org.libreoffice", "net.shinyfrog.bear", "com.bear-writer",
  ],
  terminal: [
    "com.apple.terminal", "com.googlecode.iterm2", "dev.warp.warp", "io.alacritty",
    "net.kovidgoyal.kitty", "com.github.wez.wezterm", "co.zeit.hyper", "org.tabby",
    "com.mitchellh.ghostty",
  ],
  browser: [
    "com.google.chrome", "com.apple.safari", "company.thebrowser.browser", "org.mozilla.firefox",
    "com.microsoft.edgemac", "com.brave.browser", "com.operasoftware.opera", "com.vivaldi.vivaldi",
    "ru.yandex.desktop.yandex-browser",
  ],
  media: [
    "com.apple.music", "com.spotify.client", "org.videolan.vlc", "com.apple.quicktimeplayerx",
    "com.colliderli.iina", "com.apple.podcasts", "com.apple.tv", "tv.plex", "com.apple.itunes",
  ],
  chat: [
    "com.tinyspeck.slackmacgap", "com.hnc.discord", "com.microsoft.teams", "com.apple.messages",
    "ru.keepcoder.telegram", "net.whatsapp.whatsapp", "us.zoom.xos",
  ],
};

const CATEGORY_NAME_TOKENS = {
  editor: [
    "visual studio code", "vscode", "cursor", "xcode", "sublime", "intellij", "pycharm",
    "webstorm", "goland", "rubymine", "phpstorm", "clion", "android studio", "microsoft word",
    "pages", "keynote", "numbers", "powerpoint", "excel", "onenote", "obsidian", "notion",
    "typora", "ia writer", "textedit", "preview", "libreoffice",
  ],
  terminal: ["terminal", "iterm", "warp", "alacritty", "kitty", "wezterm", "hyper", "ghostty"],
  browser: ["google chrome", "safari", "firefox", "microsoft edge", "brave", "vivaldi", "chromium"],
  media: ["spotify", "vlc", "quicktime", "iina", "podcasts", "plex"],
  chat: ["slack", "discord", "microsoft teams", "messages", "telegram", "whatsapp", "zoom"],
};

function matchTokens(value, tokenMap) {
  for (const category of Object.keys(tokenMap)) {
    const tokens = tokenMap[category];
    for (let i = 0; i < tokens.length; i += 1) {
      if (value.includes(tokens[i])) return category;
    }
  }
  return null;
}

function classifyApp(app) {
  if (!app) return null;
  const bundle = String(app.bundle || "").toLowerCase();
  const name = String(app.name || "").toLowerCase();
  if (bundle) {
    const byBundle = matchTokens(bundle, CATEGORY_BUNDLE_TOKENS);
    if (byBundle) return byBundle;
  }
  if (name) {
    const byName = matchTokens(name, CATEGORY_NAME_TOKENS);
    if (byName) return byName;
  }
  return null;
}

// Categories that count as "a document is open" → thinking when not typing.
// Browsers/terminals/chat are intentionally excluded: idling in them should not
// pin the pet to thinking. (Typing in any app is handled separately and wins.)
const DOCUMENT_CATEGORIES = new Set(["editor"]);

function isDocumentCategory(category) {
  return DOCUMENT_CATEGORIES.has(category);
}

// Pure decision: given already-computed boolean signals, pick the ambient state
// (a state name hikari/theme.json defines) or null to release back to idle.
// Priority: active typing > audio playing > document open (idle) > nothing.
function decideAmbientState(signals) {
  const s = signals || {};
  if (!s.userActive) return null;     // user is away → let the sleep sequence win
  if (s.typing) return "working";     // typing in any app → typing animation
  if (s.audioPlaying) return "music"; // audio output (e.g. Chrome music) → headphones
  if (s.documentOpen) return "thinking"; // a document is open but no typing → thinking
  return null;
}

module.exports = {
  classifyApp,
  isDocumentCategory,
  decideAmbientState,
  DOCUMENT_CATEGORIES,
  CATEGORY_BUNDLE_TOKENS,
  CATEGORY_NAME_TOKENS,
};
