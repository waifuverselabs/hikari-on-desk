<p align="center">
  <img src="assets/icon.png" width="140" alt="Hikari on Desk">
</p>
<h1 align="center">Hikari on Desk</h1>
<p align="center">
  <b>Hikari</b> is a pixel desktop pet who lives on your screen and reacts to what <i>you're</i> doing —
  your typing, your music, the document you're reading — <i>and</i> to your AI coding agents, in real time.
</p>
<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Platform">
  <a href="LICENSE"><img src="https://img.shields.io/badge/code-AGPL--3.0-blue" alt="AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/art-%C2%A9%20waifuverselabs-ff9f1c" alt="Art © waifuverselabs">
  <img src="https://img.shields.io/badge/telemetry-none-brightgreen" alt="No telemetry">
</p>

<p align="center">
  <img src="assets/gif/hikari-idle.gif" width="116" alt="idle">
  <img src="assets/gif/hikari-typing.gif" width="116" alt="typing">
  <img src="assets/gif/hikari-music.gif" width="116" alt="dancing">
  <img src="assets/gif/hikari-happy.gif" width="116" alt="happy">
  <img src="assets/gif/hikari-sleeping.gif" width="116" alt="sleeping">
</p>

> **Hikari on Desk** is built on the open-source desktop-pet engine **[clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)** by **[rullerzhou-afk](https://github.com/rullerzhou-afk)**, used under **AGPL-3.0**. The **Hikari** character and all of her artwork are original work **© waifuverselabs**. See [Credits & License](#credits--license).

---

## 🎧 Ambient mode — she reacts to *you*

Hikari watches your own desktop activity (no AI agent required) and mirrors it:

| What you're doing | Hikari | How it's detected (permission-free) |
|---|:---:|---|
| **Typing** in any app | <img src="assets/gif/hikari-typing.gif" width="84"> | real key-presses — mouse / scroll / clicks don't count |
| **Music actually playing** (Spotify / Apple Music) | <img src="assets/gif/hikari-music.gif" width="84"> | the player reports *playing* — paused / silent apps don't trigger it |
| **Reading** an open document | <img src="assets/gif/hikari-thinking.gif" width="84"> | an editor / document is focused and you're not typing |
| **Idle / away** | <img src="assets/gif/hikari-sleeping.gif" width="84"> | no keyboard **or** mouse for a while → yawn → doze → sleep |

- **You come first.** Your typing and music take priority over agent activity; the agent only fills the gaps when you're idle.
- **Keyboard-aware sleep.** She sleeps only when you're *truly* inactive (keyboard **and** mouse), and wakes on any key press or mouse move.
- **Private & cross-platform.** No accessibility prompts, no telemetry. Ambient detection runs on **macOS and Windows** — typing (CoreGraphics / `GetAsyncKeyState`), music (Spotify·Apple Music player state / Windows SMTC "now playing"), and the focused app (`lsappinfo` / `GetForegroundWindow`).

Toggle it in **Settings → General → Ambient desktop activity**.

## 🤖 Agent mode — she reacts to your AI coding agent

Start a long task, walk away, and come back when Hikari tells you it's done.

| Agent event | Hikari |
|---|:---:|
| You prompt / it's thinking | <img src="assets/gif/hikari-thinking.gif" width="76"><br><sub>thinking</sub> |
| Tools running | <img src="assets/gif/hikari-typing.gif" width="76"><br><sub>working</sub> |
| Multiple subagents | <img src="assets/gif/hikari-juggling.gif" width="76"><br><sub>juggling</sub> |
| Needs your permission | <img src="assets/gif/hikari-notification.gif" width="76"><br><sub>alert</sub> |
| Something failed | <img src="assets/gif/hikari-error.gif" width="76"><br><sub>error</sub> |
| Task complete | <img src="assets/gif/hikari-happy.gif" width="76"><br><sub>done!</sub> |

Works with **Claude Code, Codex CLI, Copilot CLI, Gemini CLI, Cursor Agent, Antigravity CLI, Kiro CLI, Kimi Code CLI, Qwen Code, opencode, Pi, OpenClaw, Hermes, CodeBuddy,** and **Qoder** — hooks/plugins auto-register on launch. Full setup, remote SSH, and per-agent notes: **[docs/guides/setup-guide.md](docs/guides/setup-guide.md)**.

## ✨ Features

- **Ambient desktop-activity mode** — reacts to your typing, real music playback, and open documents (the headline above)
- **Agent reactions** across 15+ AI coding CLIs, with blocking permission bubbles where supported
- **Keyboard-aware idle → yawn → doze → sleep**, and instant wake on input
- **Mini mode** — tuck her to a screen edge; she peeks out on hover
- **No telemetry** — local-only HTTP on `127.0.0.1`, nothing leaves your machine
- Cross-platform desktop app (Windows / macOS / Linux); custom themes supported

## 🚀 Run it

> Prebuilt installers aren't published yet — run from source:

```bash
git clone https://github.com/waifuverselabs/hikari-on-desk.git
cd hikari-on-desk
npm install
npm start
```

Requires Node.js. On macOS, the first time music detection runs you'll get a one-time *"Hikari on Desk wants to control Spotify"* prompt — allow it for the dance to trigger.

## 🎨 The Hikari theme

Hikari ships as the single built-in theme — a chibi catgirl with headphones, hand-animated across ~25 states (idle, typing, thinking, dancing, juggling, sweeping, sleeping, reactions, mini mode, and more). The animation source sheets live in [`themes/hikari/source-sheets/`](themes/hikari/source-sheets).

## Credits & License

**Code** — Hikari on Desk is a fork of **[clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)** by **[rullerzhou-afk](https://github.com/rullerzhou-afk)**, used under the **[GNU Affero General Public License v3.0](LICENSE)** (AGPL-3.0). Our additions — ambient mode, keyboard-aware sleep/wake, player-state audio detection, and the Hikari-only build — are likewise AGPL-3.0. The modification notice required by the AGPL is in **[`NOTICE.md`](NOTICE.md)**.

**Art** — the **Hikari** character, all of her animations, and the app icons are original artwork **© 2026 waifuverselabs. All rights reserved.** This artwork is **not** covered by AGPL-3.0; see **[`assets/LICENSE`](assets/LICENSE)**.

**Agent logos** in `assets/icons/agents/` are the trademarks of their respective owners (Anthropic, OpenAI, Google, GitHub, Cursor, and others) and are used only to identify those integrations.

**No cryptocurrency.** This project has no token, coin, NFT, or airdrop.
