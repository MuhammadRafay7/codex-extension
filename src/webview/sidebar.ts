declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): any; setState(state: unknown): void };
const api = acquireVsCodeApi();

type Thread = {
  id: string; name?: string | null; preview?: string; model?: string | null;
  forkedFromId?: string | null; updatedAt?: number; recencyAt?: number; createdAt?: number;
  status?: { type?: string };
};
const list = document.getElementById("threads")!;
const search = document.getElementById("search") as HTMLInputElement;
const projectsNav = document.getElementById("projects")!;
const count = document.getElementById("count")!;
const statusLabel = document.getElementById("status")!;
const usage = document.getElementById("usage")!;
const usageUpdated = document.getElementById("usage-updated")!;
const accountName = document.getElementById("account-name")!;
const plan = document.getElementById("plan")!;
let threads: Thread[] = [];
let active: string | null = null;
let loaded = false;
let organization: { projects: { id: string; name: string }[]; assignments: Record<string, string>; pinned: string[] } = { projects: [], assignments: {}, pinned: [] };
let selectedProject: string = api.getState()?.selectedProject || "all";

function renderProjects(): void {
  if (selectedProject !== "all" && selectedProject !== "pinned" && !organization.projects.some(project => project.id === selectedProject)) selectedProject = "all";
  projectsNav.replaceChildren();
  const entries = [{ id: "all", name: "All chats", count: threads.length },
    { id: "pinned", name: "Pinned", count: threads.filter(thread => organization.pinned.includes(thread.id)).length },
    ...organization.projects.map(project => ({ ...project, count: threads.filter(thread => organization.assignments[thread.id] === project.id).length }))];
  for (const entry of entries) {
    const row = document.createElement("div"); row.className = `project-row${selectedProject === entry.id ? " selected" : ""}`;
    const button = document.createElement("button"); button.className = "project-main";
    const icon = document.createElement("span"); icon.className = "project-icon"; icon.textContent = entry.id === "all" ? "▤" : entry.id === "pinned" ? "◆" : "▣";
    const name = document.createElement("span"); name.className = "project-name"; name.textContent = entry.name;
    const badge = document.createElement("span"); badge.className = "project-count"; badge.textContent = String(entry.count);
    button.append(icon, name, badge);
    button.onclick = () => { selectedProject = entry.id; api.setState({ selectedProject }); renderProjects(); renderThreads(); };
    row.append(button);
    if (entry.id !== "all" && entry.id !== "pinned") {
      const more = document.createElement("button"); more.className = "project-more"; more.textContent = "⋯";
      more.title = `Actions for ${entry.name}`; more.setAttribute("aria-label", `Actions for ${entry.name}`);
      more.onclick = () => api.postMessage({ type: "projectActions", projectId: entry.id }); row.append(more);
    }
    projectsNav.append(row);
  }
}

function title(thread: Thread): string {
  return thread.name?.trim() || thread.preview?.trim().split("\n")[0].slice(0, 90) || "Untitled conversation";
}
function timestamp(thread: Thread): number { return thread.recencyAt || thread.updatedAt || thread.createdAt || 0; }
function group(thread: Thread): string {
  const date = new Date(timestamp(thread) * 1000);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.floor((today.getTime() - day.getTime()) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  if (days < 30) return "This month";
  return date.toLocaleString(undefined, { month: "long", year: "numeric" });
}
function threadDate(thread: Thread): string {
  const value = timestamp(thread); if (!value) return "";
  const date = new Date(value * 1000);
  return group(thread) === "Today"
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function preview(thread: Thread): string {
  const lines = (thread.preview || "").split("\n").map(line => line.trim()).filter(Boolean);
  return thread.name?.trim() ? (lines[0] || "Open conversation") : (lines[1] || "Open conversation");
}
function metaPart(text: string, className?: string): HTMLElement {
  const span = document.createElement("span"); span.textContent = text;
  if (className) span.className = className;
  return span;
}
function renderThreads(): void {
  list.replaceChildren();
  const query = search.value.trim().toLocaleLowerCase();
  const scoped = threads.filter(thread => selectedProject === "all" ||
    (selectedProject === "pinned" ? organization.pinned.includes(thread.id) : organization.assignments[thread.id] === selectedProject));
  const filtered = scoped.filter(thread => `${title(thread)} ${thread.preview || ""} ${thread.model || ""}`.toLocaleLowerCase().includes(query));
  count.textContent = query ? `${filtered.length}/${scoped.length}` : `${scoped.length}`;
  if (!filtered.length) {
    const empty = document.createElement("p"); empty.className = "empty-list";
    empty.textContent = !loaded ? "Loading conversations…" : query ? "No matching conversations." : "No conversations yet. Start a new chat.";
    list.append(empty); return;
  }
  let currentGroup = "";
  let wrapper: HTMLElement | undefined;
  const pinned = new Set(organization.pinned);
  filtered.sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || timestamp(b) - timestamp(a));
  for (const thread of filtered) {
    const nextGroup = pinned.has(thread.id) ? "Pinned" : group(thread);
    if (nextGroup !== currentGroup) {
      wrapper = document.createElement("section"); wrapper.className = "group";
      const heading = document.createElement("div"); heading.className = "group-title"; heading.textContent = nextGroup;
      wrapper.append(heading); list.append(wrapper); currentGroup = nextGroup;
    }
    const row = document.createElement("div"); row.className = `thread${thread.id === active ? " active" : ""}`;
    const main = document.createElement("button"); main.className = "thread-main"; main.title = title(thread);
    const name = document.createElement("span"); name.className = "thread-title"; name.textContent = title(thread);
    if (pinned.has(thread.id)) { const pin = document.createElement("span"); pin.className = "thread-pin"; pin.textContent = "◆"; pin.title = "Pinned"; name.prepend(pin); }
    const excerpt = document.createElement("span"); excerpt.className = "thread-preview"; excerpt.textContent = preview(thread);
    const meta = document.createElement("span"); meta.className = "thread-meta";
    if (thread.forkedFromId) meta.append(metaPart("↳ Branch", "branch-tag"));
    const projectName = organization.projects.find(project => project.id === organization.assignments[thread.id])?.name;
    if (selectedProject === "all" && projectName) meta.append(metaPart(projectName, "project-tag"));
    if (thread.status?.type === "active") meta.append(metaPart("● Working"));
    if (thread.model) meta.append(metaPart(thread.model));
    const date = threadDate(thread); if (date) meta.append(metaPart(date));
    main.append(name, excerpt, meta);
    main.onclick = () => { active = thread.id; renderThreads(); api.postMessage({ type: "resumeThread", threadId: thread.id }); };
    const more = document.createElement("button"); more.className = "thread-more"; more.title = "Conversation actions";
    more.setAttribute("aria-label", `Actions for ${title(thread)}`); more.textContent = "⋯";
    more.onclick = () => api.postMessage({ type: "threadActions", threadId: thread.id, parentThreadId: thread.forkedFromId, text: title(thread) });
    row.append(main, more); wrapper!.append(row);
  }
}
function compact(value: number): string { return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value); }
function windowLabel(minutes: number | undefined, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes < 60) return `${minutes}m limit`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h limit`;
  return `${Math.round(minutes / 1440)}d limit`;
}
function metric(value: number, label: string): HTMLElement {
  const card = document.createElement("div"); card.className = "usage-total";
  const amount = document.createElement("strong"); amount.textContent = compact(value);
  const caption = document.createElement("span"); caption.textContent = label;
  card.append(amount, caption); return card;
}
function usageWindow(window: any, fallback: string): void {
  if (!window || typeof window.usedPercent !== "number") return;
  const row = document.createElement("div"); row.className = "usage-row";
  const heading = document.createElement("div"); heading.className = "usage-heading";
  heading.append(metaPart(windowLabel(window.windowDurationMins, fallback)), metaPart(`${Math.round(window.usedPercent)}% used`));
  const meter = document.createElement("div"); meter.className = "meter";
  meter.setAttribute("role", "progressbar"); meter.setAttribute("aria-label", windowLabel(window.windowDurationMins, fallback));
  meter.setAttribute("aria-valuenow", String(Math.max(0, Math.min(100, window.usedPercent))));
  meter.setAttribute("aria-valuemin", "0"); meter.setAttribute("aria-valuemax", "100");
  const fill = document.createElement("div"); fill.className = `meter-fill${window.usedPercent >= 85 ? " high" : ""}`;
  fill.style.width = `${Math.max(0, Math.min(100, window.usedPercent))}%`; meter.append(fill);
  row.append(heading, meter);
  if (window.resetsAt) {
    const reset = document.createElement("div"); reset.className = "usage-detail";
    reset.textContent = `Resets ${new Date(window.resetsAt * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
    row.append(reset);
  }
  usage.append(row);
}
function renderAccount(account: any, limits: any, activity: any, updatedAt?: number): void {
  accountName.textContent = account?.email || (account?.type === "apiKey" ? "API key account" : account?.type === "amazonBedrock" ? "Amazon Bedrock" : "Account unavailable");
  const bucket = limits?.rateLimits;
  const accountPlan = account?.planType || bucket?.planType;
  plan.textContent = accountPlan ? `${String(accountPlan).toUpperCase()} plan` : account?.type === "apiKey" ? "API usage" : "Codex account";
  usageUpdated.textContent = updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : "";
  usage.replaceChildren();
  const summary = activity?.summary;
  const daily = Array.isArray(activity?.dailyUsageBuckets) ? activity.dailyUsageBuckets : [];
  const latest = [...daily].sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)))[0];
  if (typeof summary?.lifetimeTokens === "number" || typeof latest?.tokens === "number") {
    const cards = document.createElement("div"); cards.className = "usage-totals";
    if (typeof summary?.lifetimeTokens === "number") cards.append(metric(summary.lifetimeTokens, "Lifetime tokens"));
    if (typeof latest?.tokens === "number") {
      const date = new Date(`${latest.startDate}T00:00:00`);
      cards.append(metric(latest.tokens, `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} tokens`));
    }
    usage.append(cards);
  }
  usageWindow(bucket?.primary, "Primary limit");
  usageWindow(bucket?.secondary, "Secondary limit");
  if (bucket?.rateLimitReachedType) {
    const reached = document.createElement("p"); reached.className = "credits"; reached.textContent = "Usage limit reached"; usage.append(reached);
  }
  if (bucket?.credits?.hasCredits && bucket.credits.balance != null) {
    const credits = document.createElement("p"); credits.className = "credits"; credits.textContent = `Credits remaining: ${bucket.credits.balance}`; usage.append(credits);
  }
  if (!usage.children.length) {
    const empty = document.createElement("p"); empty.className = "usage-empty";
    empty.textContent = account?.type === "apiKey" ? "Usage is managed in your API account." : "Usage data unavailable for this account.";
    usage.append(empty);
  }
}
document.getElementById("new")!.onclick = () => api.postMessage({ type: "newThread", projectId: selectedProject === "all" || selectedProject === "pinned" ? undefined : selectedProject });
document.getElementById("new-project")!.onclick = () => api.postMessage({ type: "newProject" });
document.getElementById("settings")!.onclick = () => api.postMessage({ type: "openSettings" });
document.getElementById("refresh")!.onclick = () => { statusLabel.textContent = "Refreshing…"; api.postMessage({ type: "refresh" }); };
search.oninput = renderThreads;
window.addEventListener("message", event => {
  const m = event.data;
  if (m.type === "threads") {
    threads = Array.isArray(m.data) ? m.data : m.data?.data || [];
    loaded = true; statusLabel.textContent = ""; renderProjects(); renderThreads();
  }
  if (m.type === "organization") { organization = m.data || organization; renderProjects(); renderThreads(); }
  if (m.type === "threadSelected" || m.type === "threadStarted") { active = m.threadId || null; renderThreads(); }
  if (m.type === "account") renderAccount(m.account, m.limits, m.usage, m.updatedAt);
  if (m.type === "uiTheme") document.body.dataset.uiTheme = m.value === "vscode" ? "vscode" : "luna";
  if (m.type === "error") statusLabel.textContent = m.message || "Error";
});
renderProjects(); renderThreads();
api.postMessage({ type: "ready" });
