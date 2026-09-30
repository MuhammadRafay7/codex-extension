const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const panels = [];
const settingsCalls = [];
const configurationValues = new Map();
const configurationListeners = [];
const saved = new Map();
let inputName = "Design research";
function webview() {
  return {
    messages: [], cspSource: "vscode-resource:",
    asWebviewUri(uri) { return { toString: () => `vscode-resource:${uri.fsPath}` }; },
    onDidReceiveMessage(callback) { this.receive = callback; },
    postMessage(message) { this.messages.push(message); return Promise.resolve(true); }
  };
}
function panel() {
  const item = {
    webview: webview(), active: true, title: "", revealCount: 0,
    reveal() { this.revealCount++; },
    onDidDispose(callback) { this.onDispose = callback; },
    onDidChangeViewState(callback) { this.onViewState = callback; },
    dispose() { this.onDispose?.(); }
  };
  panels.push(item); return item;
}
const vscode = {
  Uri: { joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
  ViewColumn: { Active: 1 },
  ConfigurationTarget: { Global: 1 },
  window: {
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    createWebviewPanel: panel,
    showQuickPick: async choices => choices.find(choice => choice.id === "branch"),
    showInputBox: async () => inputName,
    showWarningMessage: async () => "Allow once"
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/tmp/project" } }],
    findFiles: async () => [{ fsPath: "/tmp/project/src/app.ts" }, { fsPath: "/tmp/project/README.md" }],
    onDidChangeConfiguration: callback => { configurationListeners.push(callback); return { dispose() {} }; },
    getConfiguration: () => ({
      get: (key, fallback) => configurationValues.get(key) ?? fallback,
      update: async (key, value) => {
        configurationValues.set(key, value);
        for (const listener of configurationListeners) listener({ affectsConfiguration: section => section === "codexCustom" || section === `codexCustom.${key}` });
      }
    })
  },
  commands: { executeCommand: async (...args) => settingsCalls.push(args) },
  env: { clipboard: { writeText: async () => undefined } }
};
class Server extends EventEmitter {
  constructor() { super(); this.requests = []; this.turns = []; this.forks = 0; this.responses = []; }
  async start() {}
  async startThread() { return "new-project-thread"; }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "thread/fork") return { thread: { id: `branch-${++this.forks}`, model: "gpt-6-sol" } };
    if (method === "thread/list") return { data: [], nextCursor: null };
    if (method === "thread/read") return { thread: { id: params.threadId, name: "Source chat", model: "gpt-6-sol", turns: [] } };
    if (method === "skills/list") return { data: [{ cwd: "/tmp/project", skills: [{ name: "reviewer", description: "Review code", path: "/tmp/skills/reviewer/SKILL.md", enabled: true }] }] };
    if (method === "model/list") return { data: [{ model: "gpt-6-sol", displayName: "GPT-6 Sol", isDefault: true }, { model: "gpt-6-astra", displayName: "GPT-6 Astra" }], nextCursor: null };
    if (method === "account/read") return { account: { type: "chatgpt", planType: "plus" } };
    if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300 } } };
    if (method === "account/usage/read") return { summary: { lifetimeTokens: 1000 }, dailyUsageBuckets: [] };
    return {};
  }
  async sendTurn(threadId, input, model, access) { this.turns.push({ threadId, input, model, access }); }
  respond(id, result) { this.responses.push({ id, result }); }
  async dispose() {}
}
const filename = path.join(root, "src/CodexSidebarProvider.ts");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText;
const loaded = new Module(filename, module);
loaded.filename = filename; loaded.paths = module.paths;
loaded.require = id => id === "vscode" ? vscode : id === "./codexAppServer" ? { CodexAppServer: Server } : require(id);
loaded._compile(compiled, filename);
const Provider = loaded.exports.CodexSidebarProvider;

(async () => {
  const state = { get: (key, fallback) => saved.get(key) ?? fallback, update: async (key, value) => { saved.set(key, structuredClone(value)); } };
  const provider = new Provider({ fsPath: root }, state);
  const sidebar = { webview: webview(), onDidDispose() {} };
  provider.resolveWebviewView(sidebar);
  await provider.handle({ type: "ready" });
  const account = sidebar.webview.messages.find(message => message.type === "account");
  assert.equal(account.usage.summary.lifetimeTokens, 1000);
  assert.equal(account.limits.rateLimits.primary.usedPercent, 30);

  const source = provider.openChat("source");
  await provider.handle({ type: "chatReady" }, source);
  await provider.loadSkills(source);
  assert.ok(source.panel.webview.messages.some(message => message.type === "skills" && message.data[0].name === "reviewer"));
  assert.equal(provider.server.requests.filter(request => request.method === "thread/resume").length, 0, "history opens without taking the writer");
  assert.ok(source.panel.webview.messages.some(message => message.type === "models"));
  await provider.handle({ type: "selectModel", model: "gpt-6-astra" }, source);
  await provider.handle({ type: "send", text: "Hello" }, source);
  assert.equal(provider.server.requests.filter(request => request.method === "thread/resume").length, 1, "writer is requested on send");
  assert.equal(provider.server.turns[0].model, "gpt-6-astra");
  assert.equal(provider.server.turns[0].threadId, "source");

  await provider.handle({ type: "selectAccess", mode: "readOnly" }, source);
  assert.deepEqual(source.access, { approvalPolicy: "never", sandbox: "read-only" });
  await provider.handle({ type: "searchFiles", query: "app" }, source);
  assert.deepEqual(source.panel.webview.messages.findLast(message => message.type === "fileSuggestions").paths, ["src/app.ts"]);
  await provider.handle({ type: "send", text: "Use $reviewer with @src/app.ts", mentions: ["src/app.ts", "../secret"] }, source);
  assert.ok(provider.server.turns[1].input.some(item => item.type === "skill" && item.name === "reviewer"));
  assert.ok(provider.server.turns[1].input.some(item => item.type === "mention" && item.name === "src/app.ts"));
  assert.equal(provider.server.turns[1].input.some(item => item.type === "mention" && item.name === "../secret"), false);
  assert.equal(provider.server.turns[1].access.sandbox, "read-only");
  await provider.handle({ type: "reviewChanges" }, source);
  await provider.handle({ type: "compactThread" }, source);
  assert.ok(provider.server.requests.some(request => request.method === "review/start" && request.params.target.type === "uncommittedChanges"));
  assert.ok(provider.server.requests.some(request => request.method === "thread/compact/start" && request.params.threadId === "source"));
  await provider.handleServerMessage({ id: 12, method: "item/permissions/requestApproval", params: { reason: "Need network", permissions: { network: { enabled: true } } } });
  assert.deepEqual(provider.server.responses[0], { id: 12, result: { permissions: { network: { enabled: true } }, scope: "turn" } });

  await provider.handle({ type: "forkThread", lastTurnId: "turn-1", text: "Source chat" }, source);
  const fork = provider.server.requests.find(request => request.method === "thread/fork");
  assert.deepEqual(fork.params, { threadId: "source", lastTurnId: "turn-1" });
  assert.equal(provider.chatsByThread.get("source"), source);
  assert.ok(provider.chatsByThread.has("branch-1"));
  assert.equal(panels.length, 2);
  assert.ok(provider.server.requests.some(request => request.method === "thread/name/set" && request.params.threadId === "branch-1"));

  await provider.handle({ type: "threadActions", threadId: "source", text: "Source chat" });
  assert.ok(provider.chatsByThread.has("branch-2"));
  assert.equal(panels.length, 3);
  assert.deepEqual(provider.server.requests.filter(request => request.method === "thread/fork")[1].params, { threadId: "source" });

  await provider.handle({ type: "newProject" });
  const projectId = provider.organization.projects[0].id;
  assert.equal(saved.get("codexCustom.organization").projects[0].name, "Design research");
  await provider.handle({ type: "togglePin", threadId: "source" });
  assert.deepEqual(saved.get("codexCustom.organization").pinned, ["source"]);
  vscode.window.showQuickPick = async choices => choices.find(choice => choice.id === projectId);
  await provider.handle({ type: "moveThread", threadId: "source" });
  assert.equal(saved.get("codexCustom.organization").assignments.source, projectId);

  await provider.handle({ type: "newThread", projectId });
  const projectChat = provider.activeChat;
  await provider.handle({ type: "send", text: "New project chat" }, projectChat);
  assert.equal(saved.get("codexCustom.organization").assignments["new-project-thread"], projectId);

  const locked = provider.openChat("locked-thread");
  await provider.handle({ type: "chatReady" }, locked);
  const resume = provider.server.request.bind(provider.server);
  provider.server.request = async (method, params) => {
    if (method === "thread/resume" && params.threadId === "locked-thread") throw new Error("thread locked-thread already has an active writer (-32600)");
    return resume(method, params);
  };
  await provider.handle({ type: "send", text: "Keep this draft" }, locked);
  assert.ok(locked.panel.webview.messages.some(message => message.type === "writerConflict"));
  assert.equal(provider.server.turns.length, 3, "locked thread receives no turn");

  await provider.handle({ type: "hideMessage", itemId: "item-1" }, source);
  assert.deepEqual(saved.get("codexCustom.hiddenMessages").source, ["item-1"]);
  await provider.handle({ type: "restoreMessage", itemId: "item-1" }, source);
  assert.deepEqual(saved.get("codexCustom.hiddenMessages").source, []);

  await provider.handle({ type: "openSettings" });
  assert.equal(provider.settingsPanel.title, "");
  await provider.handleSettingsMessage({ type: "settingsReady" });
  assert.ok(provider.settingsPanel.webview.messages.some(message => message.type === "settings"));
  await provider.handleSettingsMessage({ type: "updateSetting", setting: "uiTheme", value: "vscode" });
  assert.equal(configurationValues.get("uiTheme"), "vscode");
  assert.ok(sidebar.webview.messages.some(message => message.type === "uiTheme" && message.value === "vscode"));
  await provider.handleSettingsMessage({ type: "openVSCodeSettings" });
  assert.equal(settingsCalls[0][0], "workbench.action.openSettings");
  console.log("PASS: access, skills, file mentions, review, compact, approvals, writer conflict, projects, pins, message hiding, theme settings, branches");
  await provider.dispose();
})().catch(error => { console.error(error); process.exitCode = 1; });
