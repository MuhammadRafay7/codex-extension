import * as vscode from "vscode";
import { CodexAppServer, JsonRpcMessage, TurnInput, TurnAccess } from "./codexAppServer";
import { spawn, execFile, ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve, relative, isAbsolute } from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

interface Attachment {
  path: string;
  kind: "image" | "document";
  name: string;
}

interface WebMessage {
  type: string;
  text?: string;
  threadId?: string;
  parentThreadId?: string;
  lastTurnId?: string;
  index?: number;
  model?: string;
  projectId?: string;
  draft?: string;
  setting?: string;
  value?: string | boolean | number;
  itemId?: string;
  mode?: string;
  query?: string;
  mentions?: string[];
}

interface ChatSession {
  panel: vscode.WebviewPanel;
  threadId?: string;
  attachments: Attachment[];
  historyRequest: number;
  writable: boolean;
  initialDraft?: string;
  projectId?: string;
  model?: string;
  access?: TurnAccess;
  skills?: { name: string; description: string; path: string; enabled: boolean }[];
}

interface Organization {
  projects: { id: string; name: string }[];
  assignments: Record<string, string>;
  pinned: string[];
}

export class CodexSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "codexCustom.sidebar";
  private view?: vscode.WebviewView;
  private readonly chats = new Set<ChatSession>();
  private readonly chatsByThread = new Map<string, ChatSession>();
  private activeChat?: ChatSession;
  private readonly server: CodexAppServer;
  private threadsRequest = 0;
  private accountRequest = 0;
  private lastTextEditor?: vscode.TextEditor;
  private readonly editorListener: vscode.Disposable;
  private readonly configurationListener: vscode.Disposable;
  private settingsPanel?: vscode.WebviewPanel;
  private organization: Organization;
  private hiddenMessages: Record<string, string[]>;
  private fileIndex?: { cwd: string; paths: string[]; loadedAt: number };
  private recording?: {
    process: ChildProcessWithoutNullStreams;
    path: string;
    closed: Promise<void>;
    owner: ChatSession;
  };

  constructor(private readonly extensionUri: vscode.Uri, private readonly globalState: vscode.Memento) {
    this.organization = globalState.get<Organization>("codexCustom.organization", {
      projects: [], assignments: {}, pinned: []
    });
    this.hiddenMessages = globalState.get<Record<string, string[]>>("codexCustom.hiddenMessages", {});
    this.server = new CodexAppServer();
    this.lastTextEditor = vscode.window.activeTextEditor;
    this.editorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) this.lastTextEditor = editor;
    });
    this.configurationListener = vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("codexCustom.uiTheme")) this.postTheme();
      if (event.affectsConfiguration("codexCustom")) this.postSettings();
    });

    this.server.on("message", ({ message }: { message: JsonRpcMessage }) => {
      void this.handleServerMessage(message);
    });

    this.server.on("stderr", (text: string) => {
      this.post({ type: "runtimeLog", text });
    });

    this.server.on("error", (error: Error) => {
      this.post({ type: "error", message: error.message });
    });

    this.server.on("exit", ({ code }: { code: number | null }) => {
      this.post({ type: "runtimeExit", code });
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "media"),
        vscode.Uri.joinPath(this.extensionUri, "dist")
      ]
    };
    view.webview.onDidReceiveMessage((message: WebMessage) => {
      void this.handle(message);
    });
    view.onDidDispose(() => { this.view = undefined; });
    view.webview.html = this.sidebarHtml(view.webview);
  }

  openChat(threadId?: string, forceNew = false, projectId?: string): ChatSession {
    const existing = forceNew ? undefined : threadId ? this.chatsByThread.get(threadId) : this.activeChat;
    if (existing) {
      existing.panel.reveal();
      this.activeChat = existing;
      this.postSidebar({ type: "threadSelected", threadId: existing.threadId ?? null });
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      "codexCustom.chat",
      "New Codex chat",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "media"),
          vscode.Uri.joinPath(this.extensionUri, "dist")
        ]
      }
    );
    const session: ChatSession = { panel, threadId, attachments: [], historyRequest: 0, writable: false,
      projectId: projectId || (threadId ? this.organization.assignments[threadId] : undefined) };
    this.chats.add(session);
    if (threadId) this.chatsByThread.set(threadId, session);
    this.activeChat = session;
    panel.webview.onDidReceiveMessage((message: WebMessage) => {
      void this.handle(message, session);
    });
    panel.onDidChangeViewState(() => {
      if (panel.active) {
        this.activeChat = session;
        this.postSidebar({ type: "threadSelected", threadId: session.threadId ?? null });
      }
    });
    panel.onDidDispose(() => {
      this.chats.delete(session);
      if (session.threadId) this.chatsByThread.delete(session.threadId);
      if (this.activeChat === session) this.activeChat = [...this.chats].at(-1);
      if (this.recording?.owner === session) this.recording.process.kill("SIGINT");
      this.postSidebar({ type: "threadSelected", threadId: this.activeChat?.threadId ?? null });
    });
    panel.webview.html = this.chatHtml(panel.webview);
    this.postSidebar({ type: "threadSelected", threadId: threadId ?? null });
    return session;
  }

  async dispose(): Promise<void> {
    this.editorListener.dispose();
    this.configurationListener.dispose();
    this.settingsPanel?.dispose();
    this.recording?.process.kill("SIGINT");
    for (const chat of this.chats) chat.panel.dispose();
    await this.server.dispose();
  }

  async updateRuntime(): Promise<void> {
    this.post({ type: "status", text: "Updating Codex runtime..." });
  }

  private async handle(message: WebMessage, session?: ChatSession): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          this.postTheme();
          this.postOrganization();
          await this.server.start();
          await Promise.all([this.loadThreads(), this.loadAccount()]);
          break;

        case "chatReady":
          if (!session) return;
          this.postTo(session, { type: "uiTheme", value: this.uiTheme() });
          this.postAccess(session);
          await this.server.start();
          this.postAttachments(session);
          void this.loadSkills(session).catch(() => this.postTo(session, { type: "skills", data: [] }));
          await this.loadModels(session);
          if (session.threadId) await this.readThread(session);
          else this.postTo(session, { type: "status", text: "Ready" });
          break;

        case "attach":
          if (session) await this.attachFiles(session);
          break;

        case "removeAttachment":
          if (session && Number.isInteger(message.index) && message.index! >= 0) {
            session.attachments.splice(message.index!, 1);
            this.postAttachments(session);
          }
          break;

        case "recordStart":
          if (session) await this.startRecording(session);
          break;

        case "recordStop":
          if (session) await this.stopRecording(session);
          break;

        case "newThread":
          this.openChat(undefined, true, message.projectId || session?.projectId);
          break;

        case "openChat":
          this.openChat();
          break;

        case "resumeThread":
          if (!message.threadId) return;
          this.openChat(message.threadId);
          break;

        case "forkThread": {
          const sourceId = session?.threadId ?? message.threadId;
          if (!sourceId) throw new Error("Open a conversation before branching it.");
          const result = await this.server.request("thread/fork", {
            threadId: sourceId,
            ...(session && message.lastTurnId ? { lastTurnId: message.lastTurnId } : {})
          }) as { thread?: { id?: string; model?: string } };
          const forkId = result.thread?.id;
          if (!forkId) throw new Error("Codex did not return a branch ID.");
          const branch = this.openChat(forkId);
          branch.writable = true;
          branch.initialDraft = session ? message.draft : undefined;
          branch.projectId = this.organization.assignments[sourceId] || session?.projectId;
          if (branch.projectId) {
            this.organization.assignments[forkId] = branch.projectId;
            await this.saveOrganization();
          }
          branch.model = result.thread?.model;
          const sourceName = (session?.panel.title || message.text || "Conversation").trim();
          const name = `Branch · ${sourceName}`.slice(0, 90);
          try {
            await this.server.request("thread/name/set", { threadId: forkId, name });
            branch.panel.title = name.slice(0, 45);
            this.postTo(branch, { type: "threadRenamed", name });
          } catch { /* The branch remains usable if naming is unavailable. */ }
          void this.loadThreads().catch(() => undefined);
          break;
        }

        case "newProject": {
          const name = await vscode.window.showInputBox({ prompt: "New project name", placeHolder: "Project name" });
          if (!name?.trim()) break;
          this.organization.projects.push({ id: randomUUID(), name: name.trim() });
          await this.saveOrganization();
          break;
        }

        case "projectActions": {
          const project = this.organization.projects.find(value => value.id === message.projectId);
          if (!project) break;
          const action = await vscode.window.showQuickPick([
            { label: "$(edit) Rename project", id: "rename" },
            { label: "$(trash) Delete project (keep conversations)", id: "delete" }
          ], { placeHolder: project.name });
          if (action?.id === "rename") {
            const name = await vscode.window.showInputBox({ prompt: "Project name", value: project.name });
            if (name?.trim()) { project.name = name.trim(); await this.saveOrganization(); }
          }
          if (action?.id === "delete") {
            this.organization.projects = this.organization.projects.filter(value => value.id !== project.id);
            for (const [threadId, projectId] of Object.entries(this.organization.assignments))
              if (projectId === project.id) delete this.organization.assignments[threadId];
            for (const chat of this.chats) if (chat.projectId === project.id) chat.projectId = undefined;
            await this.saveOrganization();
          }
          break;
        }

        case "togglePin":
          if (!message.threadId) break;
          this.organization.pinned = this.organization.pinned.includes(message.threadId)
            ? this.organization.pinned.filter(id => id !== message.threadId)
            : [...this.organization.pinned, message.threadId];
          await this.saveOrganization();
          break;

        case "moveThread": {
          if (!message.threadId) break;
          const choice = await vscode.window.showQuickPick([
            { label: "Unsorted", id: "" },
            ...this.organization.projects.map(project => ({ label: project.name, id: project.id }))
          ], { placeHolder: "Move conversation to project" });
          if (!choice) break;
          if (choice.id) this.organization.assignments[message.threadId] = choice.id;
          else delete this.organization.assignments[message.threadId];
          const moved = this.chatsByThread.get(message.threadId);
          if (moved) moved.projectId = choice.id || undefined;
          await this.saveOrganization();
          break;
        }

        case "threadActions": {
          if (!message.threadId) return;
          const actions = [
            { label: this.organization.pinned.includes(message.threadId) ? "$(pin) Unpin conversation" : "$(pin) Pin conversation", id: "pin" },
            { label: "$(folder) Move to project", id: "move" },
            { label: "$(git-branch) Branch conversation", id: "branch" },
            { label: "$(edit) Rename conversation", id: "rename" },
            { label: "$(copy) Copy conversation ID", id: "copy" },
            ...(message.parentThreadId ? [{ label: "$(arrow-left) Open source conversation", id: "parent" }] : [])
          ];
          const chosen = await vscode.window.showQuickPick(actions, { placeHolder: message.text || "Conversation actions" });
          if (chosen?.id === "pin") await this.handle({ type: "togglePin", threadId: message.threadId });
          if (chosen?.id === "move") await this.handle({ type: "moveThread", threadId: message.threadId });
          if (chosen?.id === "branch") await this.handle({ type: "forkThread", threadId: message.threadId, text: message.text });
          if (chosen?.id === "rename") await this.handle({ type: "renameThread", threadId: message.threadId, text: message.text });
          if (chosen?.id === "copy") await vscode.env.clipboard.writeText(message.threadId);
          if (chosen?.id === "parent" && message.parentThreadId)
            await this.handle({ type: "resumeThread", threadId: message.parentThreadId });
          break;
        }

        case "renameThread": {
          if (!message.threadId) return;
          const name = await vscode.window.showInputBox({ prompt: "Conversation name", value: message.text ?? "" });
          if (!name?.trim()) return;
          await this.server.request("thread/name/set", { threadId: message.threadId, name: name.trim() });
          const renamed = this.chatsByThread.get(message.threadId);
          if (renamed) {
            renamed.panel.title = name.trim().slice(0, 45);
            this.postTo(renamed, { type: "threadRenamed", name: name.trim() });
          }
          await this.loadThreads();
          break;
        }

        case "send":
          if (session) await this.send(session, message.text ?? "", message.mentions || []);
          break;

        case "selectModel":
          if (session && typeof message.model === "string") {
            session.model = message.model || undefined;
            this.postTo(session, { type: "modelSelected", model: session.model ?? "" });
          }
          break;

        case "selectAccess":
          if (!session) break;
          session.access = message.mode === "readOnly" ? { approvalPolicy: "never", sandbox: "read-only" }
            : message.mode === "full" ? { approvalPolicy: "never", sandbox: "danger-full-access" }
            : { approvalPolicy: "on-request", sandbox: "workspace-write" };
          this.postAccess(session);
          break;

        case "searchFiles":
          if (session) await this.searchFiles(session, message.query || "");
          break;

        case "reviewChanges":
          if (!session) break;
          if (!session.threadId) await this.createThread(session);
          if (!session.threadId) break;
          if (!session.writable) {
            await this.server.request("thread/resume", { threadId: session.threadId });
            session.writable = true;
          }
          await this.server.request("review/start", {
            threadId: session.threadId, target: { type: "uncommittedChanges" }, delivery: "inline"
          });
          break;

        case "compactThread":
          if (!session?.threadId) throw new Error("Open a conversation before compacting it.");
          if (!session.writable) {
            await this.server.request("thread/resume", { threadId: session.threadId });
            session.writable = true;
          }
          await this.server.request("thread/compact/start", { threadId: session.threadId });
          this.postTo(session, { type: "status", text: "Compacting conversation…" });
          break;

        case "openSettings":
          this.openSettings();
          break;

        case "hideMessage":
          if (!session?.threadId || !message.itemId) break;
          if (!this.hiddenMessages[session.threadId]) this.hiddenMessages[session.threadId] = [];
          if (!this.hiddenMessages[session.threadId].includes(message.itemId)) {
            this.hiddenMessages[session.threadId].push(message.itemId);
            await this.globalState.update("codexCustom.hiddenMessages", this.hiddenMessages);
          }
          this.postTo(session, { type: "messageHidden", itemId: message.itemId });
          break;

        case "restoreMessage":
          if (!session?.threadId || !message.itemId) break;
          this.hiddenMessages[session.threadId] = (this.hiddenMessages[session.threadId] || [])
            .filter(id => id !== message.itemId);
          await this.globalState.update("codexCustom.hiddenMessages", this.hiddenMessages);
          await this.readThread(session);
          break;

        case "interrupt":
          if (session?.threadId) await this.server.interruptTurn(session.threadId);
          break;

        case "refresh":
          await Promise.all([this.loadThreads(), this.loadAccount()]);
          break;

      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (session && /already has an active writer/i.test(detail)) {
        this.postTo(session, { type: "writerConflict", message: "This conversation is open in another Codex session. You can read it here or branch it to continue." });
        return;
      }
      this.postTo(session, {
        type: "error",
        message: detail
      });
    }
  }

  private async createThread(session: ChatSession): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error("Open a workspace folder before starting Codex.");

    const threadId = await this.server.startThread(folder.uri.fsPath, session.model, session.access);
    if (!this.chats.has(session)) return;
    session.threadId = threadId;
    session.writable = true;
    if (session.projectId) {
      this.organization.assignments[threadId] = session.projectId;
      await this.saveOrganization();
    }
    this.chatsByThread.set(threadId, session);
    this.postTo(session, { type: "threadStarted", threadId });
    if (this.activeChat === session) this.postSidebar({ type: "threadSelected", threadId });
    void this.loadThreads().catch(() => undefined);
  }

  private async send(session: ChatSession, text: string, mentions: string[]): Promise<void> {
    if (!text.trim() && session.attachments.length === 0) return;
    if (!session.threadId) await this.createThread(session);
    if (!session.threadId || !this.chats.has(session)) return;
    if (!session.writable) {
      await this.server.request("thread/resume", { threadId: session.threadId });
      session.writable = true;
    }

    const context = this.editorContext();
    const input: TurnInput[] = [];
    const documentBlocks: string[] = [];
    for (const attachment of session.attachments) {
      if (attachment.kind === "image") {
        input.push({ type: "localImage", path: attachment.path });
      } else {
        documentBlocks.push(await this.readDocument(attachment));
      }
    }
    const message = [text.trim() || "Please respond to the attached content.", context, ...documentBlocks]
      .filter(Boolean).join("\n\n");
    input.unshift({ type: "text", text: message });
    for (const match of text.matchAll(/(?:^|\s)\$([\w.-]+)/g)) {
      const skill = session.skills?.find(value => value.enabled && value.name === match[1]);
      if (skill && !input.some(item => item.type === "skill" && item.name === skill.name))
        input.push({ type: "skill", name: skill.name, path: skill.path });
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder) for (const name of new Set(mentions)) {
      if (!name || isAbsolute(name) || !text.includes(`@${name}`)) continue;
      const path = resolve(folder, name);
      const fromRoot = relative(folder, path);
      if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) continue;
      input.push({ type: "mention", name, path });
    }
    if (session.panel.title === "New Codex chat")
      session.panel.title = (text.trim().split("\n")[0] || "Attached content").slice(0, 45);
    await this.server.sendTurn(session.threadId, input, session.model, session.access);
    session.attachments = [];
    this.postAttachments(session);
    this.postTo(session, { type: "sendAccepted" });
  }

  private async attachFiles(session: ChatSession): Promise<void> {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: "Attach to Codex",
      filters: {
        "Images": ["png", "jpg", "jpeg", "gif", "webp"],
        "Documents": ["pdf", "txt", "md", "markdown", "csv", "json", "log"],
        "Audio": ["wav", "mp3", "m4a", "ogg", "webm"]
      }
    });
    if (!files) return;
    for (const file of files) {
      const path = file.fsPath;
      const extension = extname(path).toLowerCase();
      const kind = [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension)
        ? "image" : "document";
      if ([".wav", ".mp3", ".m4a", ".ogg", ".webm"].includes(extension)) {
        await this.transcribeAudio(session, path);
      } else {
        session.attachments.push({ path, kind, name: basename(path) });
      }
    }
    this.postAttachments(session);
  }

  private postAttachments(session: ChatSession): void {
    this.postTo(session, { type: "attachments", files: session.attachments.map(({ name, kind }) => ({ name, kind })) });
  }

  private async readDocument(attachment: Attachment): Promise<string> {
    const extension = extname(attachment.path).toLowerCase();
    let content: string;
    if (extension === ".pdf") {
      const result = await execFileAsync("pdftotext", ["-layout", attachment.path, "-"], {
        maxBuffer: 8 * 1024 * 1024
      });
      content = result.stdout;
    } else if ([".txt", ".md", ".markdown", ".csv", ".json", ".log"].includes(extension)) {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(attachment.path));
      if (bytes.byteLength > 2 * 1024 * 1024) throw new Error(`${attachment.name} is too large to attach.`);
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } else {
      throw new Error(`Unsupported document type: ${attachment.name}`);
    }
    if (!content.trim()) throw new Error(`${attachment.name} contains no readable text.`);
    const limit = 120_000;
    const trimmed = content.length > limit ? `${content.slice(0, limit)}\n[Document truncated]` : content;
    return `--- ATTACHED DOCUMENT: ${attachment.name} ---\n${trimmed}\n--- END DOCUMENT ---`;
  }

  private async startRecording(session: ChatSession): Promise<void> {
    if (this.recording) {
      if (this.recording.owner !== session) throw new Error("Finish dictation in the other chat first.");
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), "codex-custom-voice-"));
    const path = join(directory, "voice.wav");
    const process = spawn("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "pulse", "-i", "default", "-ac", "1", "-ar", "16000",
      "-c:a", "pcm_s16le", "-y", path
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let details = "";
    process.stderr.on("data", (chunk: Buffer) => { details += chunk.toString().slice(0, 500); });
    const closed = new Promise<void>((resolve) => { process.once("close", () => resolve()); });
    await new Promise<void>((resolve, reject) => {
      process.once("spawn", () => resolve());
      process.once("error", reject);
    });
    this.recording = { process, path, closed, owner: session };
    process.once("close", () => {
      if (this.recording?.process === process) {
        this.recording = undefined;
        this.postTo(session, { type: "recording", active: false });
        this.postTo(session, { type: "error", message: `Microphone recording stopped. ${details}`.trim() });
      }
    });
    this.postTo(session, { type: "recording", active: true });
  }

  private async stopRecording(session: ChatSession): Promise<void> {
    const recording = this.recording;
    if (!recording || recording.owner !== session) return;
    this.recording = undefined;
    recording.process.kill("SIGINT");
    await recording.closed;
    this.postTo(session, { type: "recording", active: false });
    const info = await stat(recording.path);
    if (info.size < 1024) throw new Error("The recording is empty. Check the microphone input and try again.");
    await this.transcribeAudio(session, recording.path);
  }

  private async transcribeAudio(session: ChatSession, path: string): Promise<void> {
    this.postTo(session, { type: "status", text: "Transcribing voice…" });
    const python = vscode.workspace.getConfiguration("codexCustom")
      .get<string>("transcriberPython", "").trim();
    if (!python) throw new Error("Set codexCustom.transcriberPython to the speech transcriber Python executable.");
    const script = join(this.extensionUri.fsPath, "scripts", "transcribe.py");
    const result = await execFileAsync(python, [script, path], {
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024
    });
    this.postTo(session, { type: "transcript", text: result.stdout.trim() });
    this.postTo(session, { type: "status", text: "Ready" });
  }

  private editorContext(): string {
    const editor = vscode.window.activeTextEditor ?? this.lastTextEditor;
    if (!editor) return "";

    const relative = vscode.workspace.asRelativePath(editor.document.uri);
    if (!editor.selection.isEmpty) {
      return `Active selection (${relative}, ${editor.document.languageId}):\n${editor.document.getText(editor.selection)}`;
    }

    return `Active file (${relative}, ${editor.document.languageId}):\n${editor.document.getText()}`;
  }

  private async loadThreads(): Promise<void> {
    const generation = ++this.threadsRequest;
    const threads: unknown[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.server.request("thread/list", {
        sourceKinds: ["vscode", "cli", "appServer"],
        sortKey: "recency_at",
        limit: 100,
        ...(cursor ? { cursor } : {})
      }) as { data?: unknown[]; nextCursor?: string | null };
      threads.push(...(result.data ?? []));
      cursor = result.nextCursor ?? undefined;
    } while (cursor && generation === this.threadsRequest);
    if (generation === this.threadsRequest)
      this.postSidebar({ type: "threads", data: threads });
  }

  private postOrganization(): void {
    this.postSidebar({ type: "organization", data: this.organization });
  }

  private uiTheme(): "luna" | "vscode" {
    return vscode.workspace.getConfiguration("codexCustom").get<string>("uiTheme", "luna") === "vscode" ? "vscode" : "luna";
  }

  private postTheme(): void {
    const message = { type: "uiTheme", value: this.uiTheme() };
    this.post(message);
    void this.settingsPanel?.webview.postMessage(message);
  }

  private settingsSnapshot(): Record<string, string | boolean | number> {
    const configuration = vscode.workspace.getConfiguration("codexCustom");
    return {
      uiTheme: this.uiTheme(),
      autoCheckRuntimeUpdates: configuration.get<boolean>("autoCheckRuntimeUpdates", true),
      autoUpdateIntervalHours: configuration.get<number>("autoUpdateIntervalHours", 2),
      model: configuration.get<string>("model", ""),
      approvalPolicy: configuration.get<string>("approvalPolicy", "on-request"),
      sandbox: configuration.get<string>("sandbox", "workspace-write"),
      codexExecutable: configuration.get<string>("codexExecutable", ""),
      npmExecutable: configuration.get<string>("npmExecutable", ""),
      transcriberPython: configuration.get<string>("transcriberPython", "")
    };
  }

  private postSettings(): void {
    void this.settingsPanel?.webview.postMessage({ type: "settings", values: this.settingsSnapshot() });
  }

  private openSettings(): void {
    if (this.settingsPanel) { this.settingsPanel.reveal(); this.postSettings(); return; }
    const panel = vscode.window.createWebviewPanel("codexCustom.settings", "Codex Custom Settings",
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media"), vscode.Uri.joinPath(this.extensionUri, "dist")] });
    this.settingsPanel = panel;
    panel.webview.onDidReceiveMessage((message: WebMessage) => { void this.handleSettingsMessage(message); });
    panel.onDidDispose(() => { if (this.settingsPanel === panel) this.settingsPanel = undefined; });
    panel.webview.html = this.webviewHtml(panel.webview, "settings");
  }

  private async handleSettingsMessage(message: WebMessage): Promise<void> {
    if (message.type === "settingsReady") { this.postSettings(); return; }
    if (message.type === "openVSCodeSettings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "codexCustom");
      return;
    }
    if (message.type !== "updateSetting" || !message.setting) return;
    const allowed = new Set(Object.keys(this.settingsSnapshot()));
    if (!allowed.has(message.setting)) return;
    const value = message.value;
    if (message.setting === "uiTheme" && value !== "luna" && value !== "vscode") return;
    if (message.setting === "autoUpdateIntervalHours" &&
      (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 168)) return;
    if (message.setting === "autoCheckRuntimeUpdates" && typeof value !== "boolean") return;
    if (message.setting === "approvalPolicy" && !["on-request", "never", "untrusted"].includes(String(value))) return;
    if (message.setting === "sandbox" && !["read-only", "workspace-write", "danger-full-access"].includes(String(value))) return;
    if (!["autoCheckRuntimeUpdates", "autoUpdateIntervalHours"].includes(message.setting) && typeof value !== "string") return;
    try {
      await vscode.workspace.getConfiguration("codexCustom").update(message.setting, value, vscode.ConfigurationTarget.Global);
      this.postSettings();
      if (message.setting === "uiTheme") this.postTheme();
      void this.settingsPanel?.webview.postMessage({ type: "saved", setting: message.setting });
    } catch (error) {
      void this.settingsPanel?.webview.postMessage({ type: "settingsError", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async saveOrganization(): Promise<void> {
    await this.globalState.update("codexCustom.organization", this.organization);
    this.postOrganization();
  }

  private async loadAccount(): Promise<void> {
    const generation = ++this.accountRequest;
    const [account, limits, usage] = await Promise.allSettled([
      this.server.request("account/read", {}),
      this.server.request("account/rateLimits/read", {}),
      this.server.request("account/usage/read", {})
    ]);
    if (generation !== this.accountRequest) return;
    this.postSidebar({
      type: "account",
      account: account.status === "fulfilled" ? (account.value as { account?: unknown }).account : null,
      limits: limits.status === "fulfilled" ? limits.value : null,
      usage: usage.status === "fulfilled" ? usage.value : null,
      updatedAt: Date.now()
    });
  }

  private async loadModels(session: ChatSession): Promise<void> {
    const models: unknown[] = [];
    try {
      let cursor: string | undefined;
      do {
        const result = await this.server.request("model/list", { ...(cursor ? { cursor } : {}) }) as {
          data?: unknown[]; nextCursor?: string | null
        };
        models.push(...(result.data ?? []));
        cursor = result.nextCursor ?? undefined;
      } while (cursor && this.chats.has(session));
    } catch { /* Keep the composer and history usable if model discovery fails. */ }
    this.postTo(session, { type: "models", data: models,
      configuredModel: vscode.workspace.getConfiguration("codexCustom").get<string>("model", "") });
  }

  private postAccess(session: ChatSession): void {
    const config = vscode.workspace.getConfiguration("codexCustom");
    const approval = session.access?.approvalPolicy ?? config.get<string>("approvalPolicy", "on-request");
    const sandbox = session.access?.sandbox ?? config.get<string>("sandbox", "workspace-write");
    const mode = sandbox === "read-only" ? "readOnly" :
      sandbox === "danger-full-access" && approval === "never" ? "full" :
      sandbox === "workspace-write" && approval === "on-request" ? "ask" : "custom";
    this.postTo(session, { type: "access", mode, approvalPolicy: approval, sandbox });
  }

  private async loadSkills(session: ChatSession, forceReload = false): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const result = await this.server.request("skills/list", {
      ...(cwd ? { cwds: [cwd] } : {}), ...(forceReload ? { forceReload: true } : {})
    }) as { data?: { skills?: { name?: string; description?: string; path?: string; enabled?: boolean }[] }[] };
    const skills = (result.data || []).flatMap(entry => entry.skills || [])
      .filter((skill): skill is { name: string; description: string; path: string; enabled: boolean } =>
        typeof skill.name === "string" && typeof skill.path === "string" && typeof skill.description === "string" && typeof skill.enabled === "boolean")
      .map(skill => ({ name: skill.name, description: skill.description, path: skill.path, enabled: skill.enabled }));
    if (!this.chats.has(session)) return;
    session.skills = skills;
    this.postTo(session, { type: "skills", data: skills.filter(skill => skill.enabled) });
  }

  private async searchFiles(session: ChatSession, query: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) { this.postTo(session, { type: "fileSuggestions", query, paths: [] }); return; }
    if (!this.fileIndex || this.fileIndex.cwd !== folder || Date.now() - this.fileIndex.loadedAt > 60_000) {
      const files = await vscode.workspace.findFiles("**/*", "**/{.git,node_modules,dist,build,.next}/**", 1500);
      this.fileIndex = { cwd: folder, paths: files.map(uri => relative(folder, uri.fsPath)).filter(path => !path.startsWith("..")), loadedAt: Date.now() };
    }
    const lower = query.toLocaleLowerCase();
    const files = this.fileIndex.paths.filter(path => path.toLocaleLowerCase().includes(lower)).slice(0, 35);
    this.postTo(session, { type: "fileSuggestions", query, paths: files });
  }

  private async readThread(session: ChatSession): Promise<void> {
    if (!session.threadId) return;
    const generation = ++session.historyRequest;
    const result = await this.server.request("thread/read", {
      threadId: session.threadId,
      includeTurns: true
    }) as { thread?: { id?: string; name?: string | null; preview?: string } };
    if (generation === session.historyRequest && this.chats.has(session)) {
      const thread = result.thread;
      if (thread?.id === session.threadId) {
        session.panel.title = (thread.name || thread.preview?.split("\n")[0] || "Codex chat").slice(0, 45);
        if (!session.model && typeof (thread as { model?: unknown }).model === "string")
          session.model = (thread as { model: string }).model;
        if (session.model) this.postTo(session, { type: "modelSelected", model: session.model });
        this.postTo(session, { type: "threadRead", data: result,
          hiddenItems: this.hiddenMessages[session.threadId] || [] });
        if (session.initialDraft) {
          this.postTo(session, { type: "draft", text: session.initialDraft });
          session.initialDraft = undefined;
        }
      }
    }
  }

  private forwardCodexMessage(message: JsonRpcMessage): void {
    const eventThread = message.params?.threadId;
    if (typeof eventThread === "string") {
      const session = this.chatsByThread.get(eventThread);
      if (session) this.postTo(session, { type: "codexEvent", data: message });
    }
    if (message.method === "turn/completed" || message.method === "thread/name/updated")
      void this.loadThreads().catch(() => undefined);
    if (message.method === "turn/completed") void this.loadAccount().catch(() => undefined);
    if (message.method === "account/rateLimits/updated" || message.method === "account/updated")
      void this.loadAccount().catch(() => undefined);
    if (message.method === "skills/changed") for (const session of this.chats)
      void this.loadSkills(session, true).catch(() => undefined);
  }

  private async handleServerMessage(message: JsonRpcMessage): Promise<void> {
    if (message.id !== undefined && message.method === "item/permissions/requestApproval") {
      const params = message.params ?? {};
      const requested = params.permissions && typeof params.permissions === "object" ? params.permissions : {};
      const detail = [params.reason ? String(params.reason) : "Codex requests extra access.",
        JSON.stringify(requested, null, 2)].join("\n\n").slice(0, 4000);
      const choice = await vscode.window.showWarningMessage("Codex requests additional access",
        { modal: true, detail }, "Allow once", "Allow for this chat", "Deny");
      this.server.respond(message.id, {
        permissions: choice === "Allow once" || choice === "Allow for this chat" ? requested : {},
        scope: choice === "Allow for this chat" ? "session" : "turn"
      });
      return;
    }
    if (message.id !== undefined && [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval"
    ].includes(message.method ?? "")) {
      const params = message.params ?? {};
      const summary = message.method?.includes("commandExecution")
        ? `Command: ${String(params.command ?? "See Codex activity for details")}`
        : `File change: ${String(params.reason ?? "See Codex activity for details")}`;
      const choice = await vscode.window.showWarningMessage(
        "Codex requests approval",
        { modal: true, detail: `${summary}\n\n${JSON.stringify(params, null, 2)}` },
        "Approve",
        "Deny"
      );
      this.server.respond(message.id, { decision: choice === "Approve" ? "accept" : "decline" });
      return;
    }
    this.forwardCodexMessage(message);
  }

  private post(message: Record<string, unknown>): void {
    this.postSidebar(message);
    for (const session of this.chats) this.postTo(session, message);
  }

  private postTo(session: ChatSession | undefined, message: Record<string, unknown>): void {
    if (session && this.chats.has(session)) void session.panel.webview.postMessage(message);
    else if (!session) this.postSidebar(message);
  }

  private postSidebar(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }

  private webviewHtml(webview: vscode.Webview, page: "sidebar" | "chat" | "settings"): string {
    const template = readFileSync(join(this.extensionUri.fsPath, "media", `${page}.html`), "utf8");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", `${page}.js`));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", `${page}.css`));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `script-src ${webview.cspSource}`
    ].join("; ");
    return template
      .replaceAll("{{CSP}}", csp)
      .replaceAll("{{SCRIPT_URI}}", scriptUri.toString())
      .replaceAll("{{STYLE_URI}}", styleUri.toString());
  }

  private sidebarHtml(webview: vscode.Webview): string {
    return this.webviewHtml(webview, "sidebar");
  }

  private chatHtml(webview: vscode.Webview): string {
    return this.webviewHtml(webview, "chat");
  }

}
