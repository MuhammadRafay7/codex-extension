export {};
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const api = acquireVsCodeApi();
const saveStatus = document.getElementById("save-status")!;
const controls = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-setting]")];
let statusTimer: number | undefined;

function announce(message: string, error = false): void {
  saveStatus.textContent = message;
  saveStatus.classList.toggle("error", error);
  if (statusTimer) window.clearTimeout(statusTimer);
  if (!error) statusTimer = window.setTimeout(() => { saveStatus.textContent = ""; }, 2400);
}

for (const control of controls) {
  control.addEventListener("change", () => {
    const setting = control.dataset.setting;
    if (!setting) return;
    if (control instanceof HTMLInputElement && control.type === "radio" && !control.checked) return;
    const value = control instanceof HTMLInputElement && control.type === "checkbox" ? control.checked
      : control instanceof HTMLInputElement && control.type === "number" ? Number(control.value)
      : control.value;
    if (setting === "autoUpdateIntervalHours" && (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 168)) {
      announce("Enter a whole number from 1 to 168.", true); return;
    }
    announce("Saving…");
    api.postMessage({ type: "updateSetting", setting, value });
  });
}

document.getElementById("open-vscode")!.addEventListener("click", () => api.postMessage({ type: "openVSCodeSettings" }));
window.addEventListener("message", event => {
  const message = event.data;
  if (message.type === "uiTheme") document.body.dataset.uiTheme = message.value === "vscode" ? "vscode" : "luna";
  if (message.type === "settings") {
    const values = message.values || {};
    document.body.dataset.uiTheme = values.uiTheme === "vscode" ? "vscode" : "luna";
    for (const control of controls) {
      const value = values[control.dataset.setting || ""];
      if (value === undefined || (document.activeElement === control && control.type !== "radio")) continue;
      if (control instanceof HTMLInputElement && control.type === "radio") control.checked = control.value === String(value);
      else if (control instanceof HTMLInputElement && control.type === "checkbox") control.checked = Boolean(value);
      else control.value = String(value);
    }
  }
  if (message.type === "saved") announce("Saved");
  if (message.type === "settingsError") announce(message.message || "Could not save setting.", true);
});
api.postMessage({ type: "settingsReady" });
