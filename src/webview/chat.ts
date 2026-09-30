import MarkdownIt from "markdown-it";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; setState(state: unknown): void; getState(): any };
const api = acquireVsCodeApi();
const md = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: true });
const defaultLink = md.renderer.rules.link_open || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank"); tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultLink(tokens, idx, options, env, self);
};
const feed = document.getElementById("feed")!;
const scroll = document.getElementById("scroll")!;
const prompt = document.getElementById("prompt") as HTMLTextAreaElement;
const send = document.getElementById("send") as HTMLButtonElement;
const stop = document.getElementById("stop") as HTMLButtonElement;
const mic = document.getElementById("mic") as HTMLButtonElement;
const title = document.getElementById("title")!;
const status = document.getElementById("status")!;
const notice = document.getElementById("notice")!;
const chips = document.getElementById("attachments")!;
const jump = document.getElementById("jump")!;
const modelPicker = document.getElementById("model") as HTMLButtonElement;
const modelLabel = document.getElementById("model-label")!;
const modelMenu = document.getElementById("model-menu")!;
const accessPicker = document.getElementById("access") as HTMLButtonElement;
const accessLabel = document.getElementById("access-label")!;
const accessMenu = document.getElementById("access-menu")!;
const commandMenu = document.getElementById("command-menu")!;
const branch = document.getElementById("branch") as HTMLButtonElement;
const conflict = document.getElementById("writer-conflict")!;
const messages = new Map<string, { element: HTMLElement; body: HTMLElement; text: string }>();
const activities = new Map<string, { element: HTMLDetailsElement; summary: HTMLElement; count: number }>();
const completedTurns = new Set<string>();
let hiddenItems = new Set<string>();
let openMenu: HTMLElement | null = null;
let threadId: string | null = null;
let busy = false;
let attachmentCount = 0;
let pending = false;
let recording = false;
let stick = true;
let selectedModel = "";
let modelChoices: { value: string; label: string }[] = [{ value: "", label: "Auto model" }];
let accessMode = "ask";
let thinkingStarted = 0;
let thinkingTimer: number | undefined;
type SkillOption = { name: string; description: string; path: string };
type Suggestion = { label: string; detail: string; kind: "command" | "skill" | "file"; value: string };
let skills: SkillOption[] = [];
let fileSuggestions: string[] = [];
let lastFileQuery = "";
let fileSearchLoading = false;
let fileSearchTimer: number | undefined;
let manualSkillList = false;
let highlightedSuggestion = 0;
const selectedMentions = new Set<string>();
const slashCommands: Suggestion[] = [
  { label: "/skills", detail: "Browse installed skills", kind: "command", value: "skills" },
  { label: "/permissions", detail: "Change access for this chat", kind: "command", value: "permissions" },
  { label: "/model", detail: "Choose a model", kind: "command", value: "model" },
  { label: "/review", detail: "Review uncommitted changes", kind: "command", value: "review" },
  { label: "/compact", detail: "Compact conversation context", kind: "command", value: "compact" },
  { label: "/new", detail: "Open a new chat tab", kind: "command", value: "new" },
  { label: "/settings", detail: "Open Codex Custom settings", kind: "command", value: "settings" },
  { label: "/status", detail: "Show current model and access", kind: "command", value: "status" }
];

function currentTrigger(): { kind: "slash" | "skill" | "file"; query: string; start: number; end: number } | null {
  const end = prompt.selectionStart;
  const before = prompt.value.slice(0, end);
  const slash = /^\/([\w-]*)$/.exec(before);
  if (slash) return { kind: "slash", query: slash[1], start: 0, end };
  const skill = /(?:^|\s)\$([\w.-]*)$/.exec(before);
  if (skill) return { kind: "skill", query: skill[1], start: end - skill[1].length - 1, end };
  const file = /(?:^|\s)@([\w./-]*)$/.exec(before);
  if (file) return { kind: "file", query: file[1], start: end - file[1].length - 1, end };
  return null;
}
function closeCommandMenu(): void { commandMenu.hidden = true; manualSkillList = false; highlightedSuggestion = 0; }
function positionCommandMenu(): void {
  commandMenu.hidden = false;
  const rect = document.querySelector(".composer")!.getBoundingClientRect();
  commandMenu.style.left = `${Math.max(8, Math.min(rect.left + 8, window.innerWidth - commandMenu.offsetWidth - 8))}px`;
  commandMenu.style.top = `${Math.max(8, rect.top - commandMenu.offsetHeight - 8)}px`;
}
function executeSlash(command: string): void {
  closeCommandMenu();
  if (command === "skills") { prompt.value = ""; sizePrompt(); updateSend(); manualSkillList = true; renderCommandMenu(); return; }
  prompt.value = ""; sizePrompt(); updateSend();
  if (command === "permissions") openAccessMenu();
  if (command === "model") openModelMenu();
  if (command === "new") api.postMessage({ type: "newThread" });
  if (command === "settings") api.postMessage({ type: "openSettings" });
  if (command === "review") api.postMessage({ type: "reviewChanges" });
  if (command === "compact") api.postMessage({ type: "compactThread" });
  if (command === "status") setNotice(`Model: ${modelLabel.textContent || "Auto"} · Access: ${accessLabel.textContent || "Ask"}`);
}
function chooseSuggestion(choice: Suggestion): void {
  if (choice.kind === "command") { executeSlash(choice.value); return; }
  const trigger = manualSkillList ? null : currentTrigger();
  const start = trigger?.start ?? prompt.selectionStart;
  const end = trigger?.end ?? prompt.selectionStart;
  const insertion = choice.kind === "skill" ? `$${choice.value} ` : `@${choice.value} `;
  prompt.setRangeText(insertion, start, end, "end");
  if (choice.kind === "file") selectedMentions.add(choice.value);
  closeCommandMenu(); prompt.focus(); sizePrompt(); updateSend();
}
function renderCommandMenu(): void {
  const trigger = currentTrigger();
  if (!manualSkillList && !trigger) { closeCommandMenu(); return; }
  const query = (manualSkillList ? "" : trigger?.query || "").toLocaleLowerCase();
  let choices: Suggestion[] = [];
  if (manualSkillList || trigger?.kind === "skill") {
    choices = skills.filter(skill => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query))
      .map(skill => ({ label: `$${skill.name}`, detail: skill.description, kind: "skill" as const, value: skill.name }));
  } else if (trigger?.kind === "file") {
    if (lastFileQuery !== trigger.query) {
      lastFileQuery = trigger.query; fileSuggestions = []; fileSearchLoading = true;
      if (fileSearchTimer) window.clearTimeout(fileSearchTimer);
      fileSearchTimer = window.setTimeout(() => api.postMessage({ type: "searchFiles", query: trigger.query }), 120);
    }
    choices = fileSuggestions.map(path => ({ label: `@${path}`, detail: "Workspace file", kind: "file" as const, value: path }));
  } else {
    choices = [...slashCommands.filter(command => command.value.includes(query)),
      ...skills.filter(skill => skill.name.toLocaleLowerCase().includes(query))
        .map(skill => ({ label: `/${skill.name}`, detail: `Skill · ${skill.description}`, kind: "skill" as const, value: skill.name }))];
  }
  commandMenu.replaceChildren(); highlightedSuggestion = 0;
  const heading = document.createElement("div"); heading.className = "command-heading";
  heading.textContent = manualSkillList || trigger?.kind === "skill" ? "SKILLS" : trigger?.kind === "file" ? "WORKSPACE FILES" : "COMMANDS & SKILLS";
  commandMenu.append(heading);
  if (!choices.length) {
    const empty = document.createElement("div"); empty.className = "command-empty";
    empty.textContent = trigger?.kind === "file" && fileSearchLoading ? "Searching files…" : "No matching options";
    commandMenu.append(empty);
  }
  choices.slice(0, 40).forEach((choice, index) => {
    const button = document.createElement("button"); button.type = "button"; button.className = `command-option${index === 0 ? " active" : ""}`;
    button.setAttribute("role", "option"); button.setAttribute("aria-selected", String(index === 0));
    const label = document.createElement("strong"); label.textContent = choice.label;
    const detail = document.createElement("small"); detail.textContent = choice.detail;
    button.append(label, detail); button.onclick = () => chooseSuggestion(choice);
    commandMenu.append(button);
  });
  positionCommandMenu();
}
function moveSuggestion(direction: number): void {
  const options = [...commandMenu.querySelectorAll<HTMLButtonElement>(".command-option")];
  if (!options.length) return;
  highlightedSuggestion = (highlightedSuggestion + direction + options.length) % options.length;
  options.forEach((option, index) => { option.classList.toggle("active", index === highlightedSuggestion); option.setAttribute("aria-selected", String(index === highlightedSuggestion)); });
  options[highlightedSuggestion].scrollIntoView({ block: "nearest" });
}
document.addEventListener("click", event => {
  if (!commandMenu.hidden && !commandMenu.contains(event.target as Node) && event.target !== prompt) closeCommandMenu();
});
document.addEventListener("keydown", event => { if (event.key === "Escape") closeCommandMenu(); });

function stopThinking(): void {
  document.getElementById("thinking")?.remove();
  if (thinkingTimer) window.clearInterval(thinkingTimer);
  thinkingTimer = undefined;
}
function startThinking(label = "Codex is working"): void {
  let row = document.getElementById("thinking");
  if (!row) {
    row = document.createElement("div"); row.id = "thinking"; row.setAttribute("role", "status");
    row.innerHTML = '<span class="thinking-mark">✦</span><span class="thinking-copy"><strong>Codex is working</strong><small>Preparing a response</small></span><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>';
    feed.append(row); thinkingStarted = Date.now();
  }
  row.querySelector("strong")!.textContent = label;
  if (!thinkingTimer) thinkingTimer = window.setInterval(() => {
    const elapsed = Math.floor((Date.now() - thinkingStarted) / 1000);
    const detail = row?.querySelector("small");
    if (detail) detail.textContent = elapsed >= 30 ? `Still working · ${elapsed}s` : elapsed >= 5 ? `${elapsed}s elapsed` : "Preparing a response";
  }, 1000);
  bottom();
}

function showModel(model: string): void {
  selectedModel = model;
  if (model && !modelChoices.some(choice => choice.value === model)) modelChoices.push({ value: model, label: model });
  modelLabel.textContent = modelChoices.find(choice => choice.value === model)?.label || "Auto model";
  renderModelChoices();
}
function renderModelChoices(): void {
  modelMenu.replaceChildren();
  for (const choice of modelChoices) {
    const option = document.createElement("button"); option.type = "button"; option.className = "model-option";
    option.setAttribute("role", "option"); option.setAttribute("aria-selected", String(choice.value === selectedModel));
    option.dataset.model = choice.value;
    const label = document.createElement("span"); label.textContent = choice.label;
    const tick = document.createElement("span"); tick.className = "model-tick"; tick.textContent = choice.value === selectedModel ? "✓" : "";
    option.append(label, tick);
    option.onclick = () => { showModel(choice.value); closeModelMenu(); api.postMessage({ type: "selectModel", model: choice.value }); modelPicker.focus(); };
    modelMenu.append(option);
  }
}
function closeModelMenu(): void { modelMenu.hidden = true; modelPicker.setAttribute("aria-expanded", "false"); }
function openModelMenu(): void {
  if (modelPicker.disabled) return;
  closeAccessMenu(); closeCommandMenu();
  modelMenu.hidden = false; modelPicker.setAttribute("aria-expanded", "true");
  const rect = modelPicker.getBoundingClientRect();
  modelMenu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - modelMenu.offsetWidth - 8))}px`;
  modelMenu.style.top = `${Math.max(8, rect.top - modelMenu.offsetHeight - 8)}px`;
  modelMenu.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
}
document.body.append(modelMenu);
modelPicker.onclick = () => modelMenu.hidden ? openModelMenu() : closeModelMenu();
modelPicker.onkeydown = event => {
  if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
    event.preventDefault(); openModelMenu();
  }
};
modelMenu.onkeydown = event => {
  const options = [...modelMenu.querySelectorAll<HTMLButtonElement>(".model-option")];
  const index = options.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault(); options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
  }
  if (event.key === "Escape") { closeModelMenu(); modelPicker.focus(); }
};
document.addEventListener("click", event => { if (!modelMenu.hidden && !modelMenu.contains(event.target as Node) && !modelPicker.contains(event.target as Node)) closeModelMenu(); });
document.addEventListener("keydown", event => { if (event.key === "Escape") closeModelMenu(); });

function closeAccessMenu(): void { accessMenu.hidden = true; accessPicker.setAttribute("aria-expanded", "false"); }
function openAccessMenu(): void {
  closeModelMenu(); closeCommandMenu(); accessMenu.hidden = false;
  accessPicker.setAttribute("aria-expanded", "true");
  const rect = accessPicker.getBoundingClientRect();
  accessMenu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - accessMenu.offsetWidth - 8))}px`;
  accessMenu.style.top = `${Math.max(8, rect.top - accessMenu.offsetHeight - 8)}px`;
  accessMenu.querySelector<HTMLButtonElement>(`[data-mode="${accessMode}"]`)?.focus();
}
document.body.append(accessMenu);
accessPicker.onclick = () => accessMenu.hidden ? openAccessMenu() : closeAccessMenu();
for (const option of accessMenu.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
  option.onclick = () => { api.postMessage({ type: "selectAccess", mode: option.dataset.mode }); closeAccessMenu(); accessPicker.focus(); };
}
document.addEventListener("click", event => {
  if (!accessMenu.hidden && !accessMenu.contains(event.target as Node) && !accessPicker.contains(event.target as Node)) closeAccessMenu();
});
document.addEventListener("keydown", event => { if (event.key === "Escape") closeAccessMenu(); });

function setNotice(value: string, error = false): void { notice.textContent = value; notice.classList.toggle("error", error); }
function updateSend(): void { send.disabled = busy || (!prompt.value.trim() && attachmentCount === 0); stop.hidden = !busy; branch.disabled = !threadId || busy; modelPicker.disabled = busy; accessPicker.disabled = busy; }
function sizePrompt(): void { prompt.style.height = "auto"; prompt.style.height = `${Math.min(170, Math.max(58, prompt.scrollHeight))}px`; }
function bottom(): void { if (stick) scroll.scrollTop = scroll.scrollHeight; jump.classList.toggle("visible", !stick && scroll.scrollHeight > scroll.clientHeight + 70); }
function closeMenu(): void { openMenu?.remove(); openMenu = null; }
function clear(): void { closeMenu(); stopThinking(); feed.replaceChildren(); messages.clear(); activities.clear(); completedTurns.clear(); conflict.hidden = true; const empty = document.createElement("div"); empty.id = "empty"; empty.innerHTML = '<div class="empty-mark">✦</div><h1>What shall we build?</h1><p>Ask about your code, explore an idea, or attach a file to begin.</p>'; feed.append(empty); title.textContent = "New conversation"; busy = false; pending = false; stick = true; updateSend(); bottom(); }
function hideEmpty(): void { document.getElementById("empty")?.remove(); }
function codeControls(container: HTMLElement): void {
  for (const pre of container.querySelectorAll("pre")) {
    const code = pre.querySelector("code"); if (!code) continue;
    const box = document.createElement("div"); box.className = "codebox";
    const head = document.createElement("div"); head.className = "codehead";
    const language = [...code.classList].find(x => x.startsWith("language-"))?.slice(9) || "code";
    const name = document.createElement("span"); name.textContent = language;
    const copy = document.createElement("button"); copy.textContent = "Copy"; copy.onclick = () => { void navigator.clipboard.writeText(code.textContent || "").then(() => { copy.textContent = "Copied"; setTimeout(() => copy.textContent = "Copy", 1400); }); };
    head.append(name, copy); pre.replaceWith(box); box.append(head, pre);
  }
}
function showMessageMenu(button: HTMLButtonElement, key: string): void {
  if (openMenu) { closeMenu(); return; }
  const entry = messages.get(key); if (!entry) return;
  const menu = document.createElement("div"); menu.className = "message-menu"; menu.setAttribute("role", "menu");
  const branchAction = document.createElement("button"); branchAction.type = "button"; branchAction.textContent = "↳ Branch after this turn";
  branchAction.setAttribute("role", "menuitem");
  const turnId = entry.element.dataset.turnId;
  branchAction.disabled = !turnId || !completedTurns.has(turnId);
  branchAction.title = branchAction.disabled ? "Available when this turn finishes" : "Create a branch through this turn";
  branchAction.onclick = () => { closeMenu(); api.postMessage({ type: "forkThread", lastTurnId: turnId, text: title.textContent }); };
  const copyAction = document.createElement("button"); copyAction.type = "button"; copyAction.textContent = "Copy message";
  copyAction.setAttribute("role", "menuitem"); copyAction.onclick = () => { void navigator.clipboard.writeText(entry.text); closeMenu(); };
  const deleteAction = document.createElement("button"); deleteAction.type = "button"; deleteAction.className = "delete-action";
  deleteAction.textContent = "Delete message from view"; deleteAction.setAttribute("role", "menuitem");
  deleteAction.title = "Hides this message locally. Codex retains it in conversation history and context.";
  deleteAction.disabled = !threadId || !turnId || !completedTurns.has(turnId) || busy;
  deleteAction.onclick = () => { closeMenu(); api.postMessage({ type: "hideMessage", itemId: key }); };
  menu.append(branchAction, copyAction, deleteAction); document.body.append(menu); openMenu = menu;
  const rect = button.getBoundingClientRect();
  const anchorBottom = entry.element.classList.contains("user") ? entry.element.getBoundingClientRect().bottom : rect.bottom;
  menu.style.top = `${Math.max(8, Math.min(anchorBottom + 4, window.innerHeight - menu.offsetHeight - 8))}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
  branchAction.focus();
}
document.addEventListener("click", event => { if (openMenu && !openMenu.contains(event.target as Node) && !(event.target as Element).closest(".message-more")) closeMenu(); });
document.addEventListener("keydown", event => { if (event.key === "Escape") closeMenu(); });
function addMessage(key: string, role: "user" | "assistant", text: string, phase?: string, turnId?: string): void {
  if (hiddenItems.has(key)) return;
  hideEmpty();
  let entry = messages.get(key);
  if (!entry) {
    const element = document.createElement("article"); element.className = `message ${role}${phase === "commentary" ? " commented" : ""}`;
    if (role === "assistant") { const label = document.createElement("div"); label.className = "role"; label.textContent = phase === "commentary" ? "Codex · working" : "Codex"; element.append(label); }
    const body = document.createElement("div"); body.className = role === "assistant" ? "markdown" : "bubble"; element.append(body);
    const more = document.createElement("button"); more.type = "button"; more.className = "message-more"; more.textContent = "⋯";
    more.title = "Message actions"; more.setAttribute("aria-label", `Actions for ${role} message`);
    more.onclick = event => { event.stopPropagation(); showMessageMenu(more, key); };
    element.append(more);
    feed.insertBefore(element, document.getElementById("thinking")); entry = { element, body, text: "" }; messages.set(key, entry);
  }
  if (turnId) entry.element.dataset.turnId = turnId;
  entry.element.classList.toggle("commented", role === "assistant" && phase === "commentary");
  const roleLabel = entry.element.querySelector(".role");
  if (roleLabel) roleLabel.textContent = phase === "commentary" ? "Codex · working" : "Codex";
  entry.text = text;
  if (role === "assistant") { entry.body.innerHTML = md.render(text); codeControls(entry.body); }
  else entry.body.textContent = text;
  bottom();
}
function activity(turnId: string, label: string, detail: string): void {
  hideEmpty();
  let group = activities.get(turnId);
  if (!group) {
    const element = document.createElement("details"); element.className = "activity";
    const summary = document.createElement("summary"); summary.textContent = "Work details";
    element.append(summary); feed.insertBefore(element, document.getElementById("thinking"));
    group = { element, summary, count: 0 }; activities.set(turnId, group);
  }
  group.count++;
  group.summary.textContent = `Work details · ${group.count} ${group.count === 1 ? "step" : "steps"}`;
  const step = document.createElement("div"); step.className = "activity-step";
  const heading = document.createElement("strong"); heading.textContent = label;
  const pre = document.createElement("pre"); pre.textContent = detail;
  step.append(heading, pre); group.element.append(step); bottom();
}
function contentText(content: any): string {
  if (!Array.isArray(content)) return "";
  return content.map(part => part.type === "text" ? part.text || "" : part.type === "image" || part.type === "localImage" ? "[Image attached]" : "").filter(Boolean).join("\n\n");
}
function item(key: string, data: any, turnId = "current", live = false): void {
  if (!data || !data.type) return;
  if (data.type === "userMessage") { if (pending) { document.getElementById("optimistic")?.remove(); messages.delete("optimistic"); pending = false; } addMessage(key, "user", contentText(data.content), undefined, turnId); }
  else if (data.type === "agentMessage") { stopThinking(); addMessage(key, "assistant", data.text || "", data.phase, turnId); messages.get(key)?.element.classList.remove("streaming"); }
  else if (data.type === "commandExecution") { if (live) startThinking("Codex is running a command"); activity(turnId, "Command", [data.command, data.aggregatedOutput || data.output || ""].filter(Boolean).join("\n\n")); }
  else if (data.type === "fileChange") activity(turnId, "File changes", JSON.stringify(data.changes || data, null, 2));
  else if (data.type === "mcpToolCall") activity(turnId, `${data.server || "Tool"} · ${data.tool || "call"}`, JSON.stringify(data.arguments || data.result || {}, null, 2));
  else if (data.type === "webSearch") activity(turnId, "Web search", data.query || "");
}
function renderThread(data: any): void {
  const thread = data.thread || data;
  if (threadId && thread.id && thread.id !== threadId) return;
  closeMenu(); stopThinking(); feed.replaceChildren(); messages.clear(); activities.clear(); completedTurns.clear(); pending = false;
  threadId = thread.id || threadId;
  title.textContent = thread.name || thread.preview?.split("\n")[0]?.slice(0, 70) || "Conversation";
  for (const turn of thread.turns || []) {
    for (const [index, value] of (turn.items || []).entries()) item(value.id || `${turn.id}-${index}`, value, turn.id);
    if (turn.id && turn.status !== "inProgress") completedTurns.add(turn.id);
  }
  if (!feed.children.length) {
    if ((thread.turns || []).length) {
      const emptyHistory = document.createElement("p"); emptyHistory.className = "loading";
      emptyHistory.textContent = "No visible messages in this conversation."; feed.append(emptyHistory);
    } else clear();
  }
  stick = true; bottom(); status.textContent = "Ready"; updateSend();
}
function sendMessage(): void {
  const value = prompt.value.trim(); if (busy || (!value && !attachmentCount)) return;
  if (/^\/[\w-]+$/.test(value)) {
    const command = value.slice(1);
    if (slashCommands.some(option => option.value === command)) executeSlash(command);
    else if (skills.some(skill => skill.name === command)) { prompt.value = `$${command} `; sizePrompt(); updateSend(); prompt.focus(); }
    else setNotice(`Unknown command: ${value}`, true);
    return;
  }
  closeModelMenu();
  if (value) { addMessage("optimistic", "user", value); messages.get("optimistic")!.element.id = "optimistic"; pending = true; if (!threadId) title.textContent = value.split("\n")[0].slice(0, 70); }
  closeCommandMenu();
  api.postMessage({ type: "send", text: value, mentions: [...selectedMentions] }); prompt.value = ""; sizePrompt(); busy = true; status.textContent = "Working…"; setNotice(""); updateSend(); stick = true; startThinking(); bottom();
}
send.onclick = sendMessage;
prompt.oninput = () => { updateSend(); sizePrompt(); renderCommandMenu(); };
prompt.onkeydown = e => {
  if (!commandMenu.hidden) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveSuggestion(e.key === "ArrowDown" ? 1 : -1); return; }
    if ((e.key === "Enter" && !e.shiftKey || e.key === "Tab") && !e.isComposing) {
      const options = commandMenu.querySelectorAll<HTMLButtonElement>(".command-option");
      if (options[highlightedSuggestion]) { e.preventDefault(); options[highlightedSuggestion].click(); return; }
    }
    if (e.key === "Escape") { e.preventDefault(); closeCommandMenu(); return; }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
};
stop.onclick = () => api.postMessage({ type: "interrupt" });
mic.onclick = () => api.postMessage({ type: recording ? "recordStop" : "recordStart" });
document.getElementById("attach")!.onclick = () => api.postMessage({ type: "attach" });
document.getElementById("new")!.onclick = () => api.postMessage({ type: "newThread" });
branch.onclick = () => api.postMessage({ type: "forkThread", text: title.textContent, draft: prompt.value });
document.getElementById("branch-conflict")!.onclick = () => api.postMessage({ type: "forkThread", text: title.textContent, draft: prompt.value });
jump.onclick = () => { stick = true; bottom(); };
scroll.onscroll = () => { stick = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100; jump.classList.toggle("visible", !stick && scroll.scrollHeight > scroll.clientHeight + 70); };
window.addEventListener("message", e => {
  const m = e.data;
  if (m.type === "clearChat") { threadId = null; clear(); setNotice(""); prompt.focus(); }
  if (m.type === "threadSelected") { threadId = m.threadId || null; if (threadId) { stopThinking(); feed.replaceChildren(); messages.clear(); activities.clear(); completedTurns.clear(); const loading = document.createElement("p"); loading.textContent = "Loading conversation…"; loading.className = "loading"; feed.append(loading); title.textContent = "Conversation"; status.textContent = "Loading…"; } updateSend(); }
  if (m.type === "threadStarted") { threadId = m.threadId || null; updateSend(); }
  if (m.type === "threadRead") { hiddenItems = new Set(m.hiddenItems || []); renderThread(m.data); setNotice(""); }
  if (m.type === "messageHidden") {
    hiddenItems.add(m.itemId); messages.get(m.itemId)?.element.remove(); messages.delete(m.itemId);
    if (!feed.children.length) {
      const emptyHistory = document.createElement("p"); emptyHistory.className = "loading";
      emptyHistory.textContent = "No visible messages in this conversation."; feed.append(emptyHistory);
    }
    notice.classList.remove("error"); notice.replaceChildren();
    const text = document.createElement("span"); text.textContent = "Message hidden here. Codex still retains it in history.";
    const undo = document.createElement("button"); undo.type = "button"; undo.className = "undo-delete"; undo.textContent = "Undo";
    undo.onclick = () => api.postMessage({ type: "restoreMessage", itemId: m.itemId });
    notice.append(text, undo);
  }
  if (m.type === "threadRenamed") title.textContent = m.name;
  if (m.type === "draft") { prompt.value = m.text || ""; sizePrompt(); updateSend(); prompt.focus(); }
  if (m.type === "models") {
    const available = (m.data || []).filter((model: any) => model && !model.hidden && model.model);
    const defaultModel = available.find((model: any) => model.isDefault)?.displayName || "Codex default";
    const current = selectedModel || m.configuredModel || "";
    modelChoices = [{ value: "", label: `Auto · ${defaultModel}` }, ...available.map((model: any) => ({ value: model.model, label: model.displayName || model.model }))];
    showModel(current);
  }
  if (m.type === "skills") { skills = Array.isArray(m.data) ? m.data : []; if (!commandMenu.hidden) renderCommandMenu(); }
  if (m.type === "fileSuggestions" && m.query === lastFileQuery) { fileSuggestions = Array.isArray(m.paths) ? m.paths : []; fileSearchLoading = false; if (!commandMenu.hidden) renderCommandMenu(); }
  if (m.type === "uiTheme") document.body.dataset.uiTheme = m.value === "vscode" ? "vscode" : "luna";
  if (m.type === "modelSelected") showModel(m.model || "");
  if (m.type === "access") {
    accessMode = m.mode || "custom";
    accessLabel.textContent = accessMode === "readOnly" ? "Read only" : accessMode === "full" ? "Full access" : accessMode === "ask" ? "Ask" : "Custom";
    accessPicker.title = `Manage access · ${m.sandbox || ""} · ${m.approvalPolicy || ""}`;
    for (const option of accessMenu.querySelectorAll<HTMLElement>("[data-mode]"))
      option.setAttribute("aria-checked", String(option.dataset.mode === accessMode));
  }
  if (m.type === "attachments") { chips.replaceChildren(); const files = m.files || []; attachmentCount = files.length; files.forEach((file: any, index: number) => { const chip = document.createElement("div"); chip.className = "chip"; const name = document.createElement("span"); name.textContent = `${file.kind === "image" ? "▧" : "▤"} ${file.name}`; const remove = document.createElement("button"); remove.title = "Remove attachment"; remove.textContent = "×"; remove.onclick = () => api.postMessage({ type: "removeAttachment", index }); chip.append(name, remove); chips.append(chip); }); updateSend(); }
  if (m.type === "recording") { recording = !!m.active; mic.classList.toggle("active", recording); mic.title = recording ? "Stop dictation" : "Dictate prompt"; setNotice(recording ? "Recording… click the microphone to transcribe." : ""); }
  if (m.type === "transcript") { prompt.value = [prompt.value.trim(), m.text].filter(Boolean).join(" "); prompt.focus(); updateSend(); sizePrompt(); setNotice("Voice added to your prompt."); }
  if (m.type === "status") { status.textContent = m.text; if (m.text === "Ready" && !busy) setNotice(""); }
  if (m.type === "sendAccepted") { selectedMentions.clear(); setNotice(""); conflict.hidden = true; }
  if (m.type === "error" || m.type === "writerConflict") {
    stopThinking();
    busy = false; status.textContent = m.type === "writerConflict" ? "Open elsewhere" : "Error";
    setNotice(m.message || "Something went wrong.", true);
    if (pending) { if (!prompt.value) prompt.value = messages.get("optimistic")?.text || ""; document.getElementById("optimistic")?.remove(); messages.delete("optimistic"); pending = false; }
    conflict.hidden = m.type !== "writerConflict"; sizePrompt(); updateSend();
  }
  if (m.type === "runtimeExit") { stopThinking(); busy = false; updateSend(); status.textContent = "Disconnected"; setNotice("Codex runtime stopped. Reopen the chat to reconnect.", true); }
  if (m.type === "codexEvent") {
    const ev = m.data || {}; const p = ev.params || {};
    if (p.threadId && threadId && p.threadId !== threadId) return;
    if (ev.method === "item/agentMessage/delta") { stopThinking(); const key = p.itemId || `stream-${p.turnId}`; const previous = messages.get(key)?.text || ""; addMessage(key, "assistant", previous + (p.delta || ""), undefined, p.turnId); messages.get(key)?.element.classList.add("streaming"); }
    if (ev.method === "item/completed" && p.item) item(p.item.id || p.itemId || `item-${messages.size}`, p.item, p.turnId || "current", true);
    if (ev.method === "turn/started") { busy = true; status.textContent = "Working…"; startThinking(); updateSend(); }
    if (ev.method === "turn/completed") { stopThinking(); for (const entry of messages.values()) entry.element.classList.remove("streaming"); busy = false; status.textContent = p.turn?.status === "failed" ? "Turn failed" : "Ready"; if (p.turn?.id) completedTurns.add(p.turn.id); updateSend(); if (p.turn?.error?.message) setNotice(p.turn.error.message, true); }
  }
});
clear(); sizePrompt(); api.postMessage({ type: "chatReady" });
