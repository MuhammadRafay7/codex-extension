import * as vscode from "vscode";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as readline from "node:readline";
import { EventEmitter } from "node:events";
import { delimiter, dirname, isAbsolute } from "node:path";

export interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface CodexEvent {
  message: JsonRpcMessage;
}

export type TurnInput =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export interface TurnAccess {
  approvalPolicy: "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}

export class CodexAppServer extends EventEmitter implements vscode.Disposable {
  private process?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private initialized = false;
  private startPromise?: Promise<void>;

  async start(): Promise<void> {
    if (this.initialized) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async startProcess(): Promise<void> {

    const executable = vscode.workspace
      .getConfiguration("codexCustom")
      .get<string>("codexExecutable", "")
      .trim() || "codex";

    this.process = spawn(executable, ["app-server"], {
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      env: {
        ...process.env,
        PATH: isAbsolute(executable)
          ? `${dirname(executable)}${delimiter}${process.env.PATH ?? ""}`
          : process.env.PATH
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    const proc = this.process;
    const stdout = readline.createInterface({ input: proc.stdout });

    stdout.on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.handleMessage(JSON.parse(line) as JsonRpcMessage);
      } catch {
        this.emit("stderr", `Invalid JSON from Codex app-server: ${line}`);
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      this.emit("stderr", data.toString());
    });

    proc.on("error", (error) => {
      this.rejectAll(error);
      this.emit("error", error);
    });

    proc.on("exit", (code, signal) => {
      this.process = undefined;
      this.initialized = false;
      const error = new Error(`Codex app-server exited (${code ?? "null"}${signal ? `, ${signal}` : ""}).`);
      this.rejectAll(error);
      this.emit("exit", { code, signal });
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codex-custom",
        title: "Codex Custom",
        version: "0.9.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });

    this.notify("initialized", {});
    this.initialized = true;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (method !== "initialize") await this.start();

    const id = ++this.sequence;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out after 20 seconds.`));
      }, 20_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); }
      });
      this.process?.stdin.write(payload, (error) => {
        if (error) {
          const pending = this.pending.get(id);
          this.pending.delete(id);
          pending?.reject(error);
        }
      });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.process) return;
    this.process.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      method,
      params
    }) + "\n");
  }

  respond(id: number | string, result: Record<string, unknown>): void {
    this.process?.stdin.write(JSON.stringify({ id, result }) + "\n");
  }

  async startIfNeeded(): Promise<void> {
    await this.start();
  }

  async startThread(cwd: string, model?: string, access?: TurnAccess): Promise<string> {
    const config = vscode.workspace.getConfiguration("codexCustom");
    const params: Record<string, unknown> = {
      cwd,
      approvalPolicy: access?.approvalPolicy ?? config.get<string>("approvalPolicy", "on-request"),
      sandbox: access?.sandbox ?? config.get<string>("sandbox", "workspace-write"),
    };

    const configuredModel = model || config.get<string>("model", "").trim();
    if (configuredModel) params.model = configuredModel;

    const result = await this.request("thread/start", params) as {
      thread?: { id?: string };
      id?: string;
    };

    const threadId = result.thread?.id ?? result.id;
    if (!threadId) throw new Error("Codex app-server did not return a thread ID.");
    return threadId;
  }

  async sendTurn(threadId: string, input: TurnInput[], model?: string, access?: TurnAccess): Promise<void> {
    await this.request("turn/start", {
      threadId,
      input,
      ...(model ? { model } : {}),
      ...(access ? {
        approvalPolicy: access.approvalPolicy,
        sandboxPolicy: { type: access.sandbox === "read-only" ? "readOnly" :
          access.sandbox === "workspace-write" ? "workspaceWrite" : "dangerFullAccess" }
      } : {})
    });
  }

  async interruptTurn(threadId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId });
  }

  async dispose(): Promise<void> {
    this.rejectAll(new Error("Codex app-server stopped."));
    this.process?.kill();
    this.process = undefined;
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (typeof message.id === "number" && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    this.emit("message", { message } satisfies CodexEvent);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
