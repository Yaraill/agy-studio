# AGY Studio

A lightweight, zero-dependency **Google Antigravity Sidecar Plugin** that renders a live pixel-art developer studio and parent-child orchestration tree in Antigravity's side panel.

Monitor **Orchestrator (`Argon` / `Neon`)**, **Swarm workers**, **subagents**, and external terminal coding CLIs (**Claude Code**, **OpenAI Codex CLI**, **GitHub Copilot CLI**, **OpenCode**, **DeepSeek CLI**) side by side in real time — without touching any auth or credential files.

## Features

- **Native Antigravity Side Panel (Zero External Dependencies):** Runs on Node.js standard library + Antigravity's built-in `sidecar_sdk` (~20–35 MB RAM, zero `npm install`, zero external CDNs).
- **Two Views (`Studio` & `Map`):**
  - **Studio (Office):** Crisp integer-grid 3/4 pixel-art workstations organized by floor (Orchestrator Deck, Swarm & Dev Floor, External CLI Lab, Coffee Lounge). Automatically collapses large Swarms into a compact strip with one-click expand.
  - **Map (Tree):** Groups subagents, native `/swarm` workers, and external CLI runs under their actual parent Orchestrator (`Argon` / `Neon`).
- **Scope Filter (`This Chat` | `All`):** Defaults to **This Chat** (showing only the active conversation, its subagents/Swarm workers, and CLIs invoked during that session) with a one-click toggle to view all recent sessions.
- **Live Inspector & Unified Feed:** Click any desk, map card, or event row to inspect the active tool, target file/command, reasoning snippet, recent steps, and token count — plus a **Jump to Chat** button for Antigravity sessions.
- **Bilingual UI (`EN` | `TR`):** Auto-detects language and lets you switch between English and Turkish on the fly.

## Supported Agents & Read-Only Log Sources

All telemetry is strictly **read-only** from local session files (head + tail slice reading for low RAM). **No `auth.json`, OAuth tokens, or credential files are ever accessed.**

| Agent / CLI | Local Session Source |
| :--- | :--- |
| **Google Antigravity** *(Orchestrator, Subagents, Native Swarm)* | `~/.gemini/antigravity/brain/<uuid>/.system_generated/logs/transcript.jsonl` & `swarm/members.json` |
| **Claude Code** | `~/.claude/projects/<project>/<session>.jsonl` |
| **OpenAI Codex CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| **GitHub Copilot CLI** | `~/.copilot/session-state/<uuid>/events.jsonl` |
| **OpenCode** *(v1 JSON & v2 SQLite)* | `~/.local/share/opencode/` (Linux/macOS) or `%LOCALAPPDATA%\opencode\` (Windows) |
| **DeepSeek CLI / Harness** | `~/.local/share/deepseek-cli/`, `~/.deepseek-cli/`, `~/.deepcode/`, or `$DSH_HOME/sessions/` |

## Installation

### Option 1 — Via Antigravity CLI (Recommended)

```bash
agy plugin install https://github.com/Yaraill/agy-studio
```

### Option 2 — Manual Install

Clone or copy this repository into your global Antigravity plugins folder:

- **Windows:** `C:\Users\<you>\.gemini\config\plugins\agy-studio`
- **macOS / Linux:** `~/.gemini/config/plugins/agy-studio`

## Usage

Once installed:
1. Click the **`+`** button on Antigravity's right-hand auxiliary pane and choose **AGY Studio**, **or**
2. Type `/agy-studio` in any conversation, **or**
3. Whenever a session launches subagents, `/swarm`, or an external CLI, the bundled rule (`rules/AGENTS.md`) automatically surfaces a clickable `[AGY Studio](sidecar://agy-studio/office/)` pill.

## License

MIT © [Yaraill](https://github.com/Yaraill)
