# Codex Custom

Codex Custom is a replacement **presentation layer** for the official Codex app-server runtime. The activity bar sidebar shows chats, while conversations open in separate editor tabs. It intentionally does not reimplement Codex's agent loop, filesystem tools, shell tools, approvals, sandboxing, model routing, sessions, or other runtime behavior.

## Architecture

```text
       Luna-inspired VS Code UI
          |
          | JSON-RPC over stdio
          v
   codex app-server
          |
          +-- agent loop
          +-- workspace tools
          +-- shell / terminal tools
          +-- Git / diffs
          +-- approvals / sandbox
          +-- model catalog
          +-- sessions / threads
          +-- Codex account/auth
```

The extension launches `codex app-server` and forwards app-server events to the custom Webview. Command and file change approval requests are shown as VS Code confirmation dialogs.

The interface takes visual cues from the [Luna web client](https://github.com/MuhammadRafay7/Luna): a compact conversation rail, translucent floating controls, a focused welcome screen, and a raised composer. The sidebar and chat remain separate VS Code views so chats can open in multiple editor tabs.

Open the gear in the sidebar for Codex Custom settings. Appearance can use the Luna colors or match the active VS Code color theme. The same page exposes conversation defaults, runtime update checks, and local executable paths.

## Composer

- **Attach** adds PNG, JPEG, GIF, or WebP images, PDF documents, plain text, Markdown, CSV, JSON, logs, or audio files. Images are passed to Codex as local image inputs. Document text is included in the turn (up to 120,000 characters per document). Audio files are transcribed into the composer.
- **Dictate** records speech on this Linux setup. Click again to stop; the transcribed words appear in the composer for review before sending. Recording uses `ffmpeg` and the default PulseAudio microphone. Transcription uses a local `faster-whisper` model and `codexCustom.transcriberPython`.
- **Model picker** in the composer loads model choices from the Codex runtime. Choosing a model applies it to the next turn and later turns in that chat.
- **Access shield** in the composer chooses read only, approval before extra access, or full access for that chat. The settings page controls defaults. Requests for extra permissions are shown as VS Code approval dialogs.
- Type `/` to browse commands, `$` to find installed Codex skills, or `@` to mention a workspace file. The menu supports arrow keys, Enter, and Tab. Skills are discovered from the runtime and sent as skill inputs; file mentions are passed as file references.
- Commands include `/skills`, `/permissions`, `/model`, `/review`, `/compact`, `/new`, `/settings`, and `/status`. Review uses the working tree, and compact condenses the current thread's context.
- Open chats from the sidebar into separate editor tabs. Each tab keeps its own thread, attachments, dictation, and response state.

## Conversations

- The sidebar lists conversations across workspaces, grouped by date, with previews, model names, and branch markers. Search matches conversation names, previews, and models. Create named projects in the sidebar, then use a conversation's menu to move it, pin it, rename it, branch it, copy its ID, or open a branch's source. New chats started while viewing a project join that project; branches inherit their source's project. Projects, assignments, and pins are saved in VS Code's extension storage.
- The sidebar's account section shows available ChatGPT usage windows, reset times, lifetime token activity, and a recent daily token count. A settings button opens this extension's settings. Account and usage fields appear only when the signed-in runtime supplies them.
- Opening an older chat loads its full thread as readable history without claiming its writer. The extension resumes the thread when you send. If another Codex session still owns the writer, your draft stays in the composer and you can branch the conversation to continue. History includes user messages, formatted Codex replies, code blocks, and a collapsed work details section.
- **Branch** in the chat header copies the full conversation into a new tab. Hover over any user or Codex message and open **⋯ → Branch after this turn** to copy history through its completed turn. The protocol branches at turn boundaries, so all messages in that turn are included.
- **Delete message from view** in a message's **⋯** menu hides that item locally across reloads and offers Undo. Codex app-server does not expose arbitrary message deletion, so the message remains in the runtime's history and context.
- After sending, a working indicator animates until response text begins streaming. It shows elapsed time if Codex takes longer, and disappears when the turn completes or errors.
- New chat opens another editor tab with an empty composer and creates a Codex thread when the first message is sent. Reopening an already open chat focuses its existing tab.

## Why this design

The official Codex repository contains the open-source Codex CLI and app-server protocol. The app-server exposes typed protocol operations for threads, turns, models, tool events, approvals, and other agent functionality. Keeping the runtime outside this extension means new Codex runtime capabilities can be consumed by the custom UI as the protocol evolves instead of being reimplemented here.

## Installation

Install the official Codex CLI/runtime separately and ensure `codex` is on PATH.

```bash
npm install -g @openai/codex
```

Or use an official Codex installer.

If `codex` is not on PATH, configure `codexCustom.codexExecutable` with the full executable path.

## Development

```bash
npm install
npm run check-types
npm run compile
npm test
npx @vscode/vsce package
```

Press `F5` to launch an Extension Development Host.

## Runtime updates

The extension exposes **Codex Custom: Update Codex Runtime**, which installs the latest official npm package with `npm install -g @openai/codex@latest`.

The extension checks for a newer npm release every two hours by default. It asks before installing an update, so active sessions are not replaced. Configure the check with:

- `codexCustom.autoCheckRuntimeUpdates`
- `codexCustom.autoUpdateIntervalHours`
- `codexCustom.npmExecutable` if npm is not on VS Code's PATH

The custom extension itself is independent of the official VS Code extension. Updating the official VS Code extension does not automatically replace this extension's UI. Instead, this project deliberately follows the official Codex runtime/app-server boundary.

## Feature compatibility

The UI forwards Codex app-server events rather than maintaining a separate OpenAI chat implementation. This preserves access to Codex's runtime-managed capabilities.

The UI formats the supported message and tool event types. Other protocol event types can be added as the app-server evolves.

A future release should regenerate the TypeScript protocol bindings from the upstream Codex schema when stronger typed UI support is needed.

## Limits

This project cannot promise byte-for-byte or feature-for-feature parity with OpenAI's proprietary VS Code frontend. The goal is to replace its layout while using the public Codex runtime/protocol wherever supported.

The message menu's delete action only hides a message in this extension. It does not remove it from Codex history or the model's context. Voice dictation currently uses a local Linux recording and transcription setup.

## Security

The extension does not ask for or store an OpenAI API key itself. Authentication is handled by the Codex runtime. Do not pass credentials through the Webview.

The app-server process executes with the same operating-system identity and workspace access available to the Codex CLI. Review Codex's current sandbox and approval configuration before enabling unattended automation.
# codex-extension
