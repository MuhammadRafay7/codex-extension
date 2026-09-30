import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { delimiter, dirname, isAbsolute } from "node:path";

function run(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: {
        ...process.env,
        PATH: isAbsolute(executable)
          ? `${dirname(executable)}${delimiter}${process.env.PATH ?? ""}`
          : process.env.PATH
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let output = "";
    let error = "";
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { error += data.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error((error || output || `${executable} exited with ${code}`).trim()));
    });
  });
}

export class CodexRuntimeUpdater implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private readonly configurationListener: vscode.Disposable;

  constructor() {
    this.configurationListener = vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("codexCustom.autoCheckRuntimeUpdates") ||
          event.affectsConfiguration("codexCustom.autoUpdateIntervalHours")) this.configureTimer();
    });
    this.configureTimer();
  }

  private configureTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const config = vscode.workspace.getConfiguration("codexCustom");
    if (!config.get<boolean>("autoCheckRuntimeUpdates", true)) return;

    const hours = config.get<number>("autoUpdateIntervalHours", 2);
    this.timer = setInterval(() => {
      void this.checkNow().catch((error: Error) => {
        console.warn("Codex update check failed:", error.message);
      });
    }, Math.max(1, hours) * 60 * 60 * 1000);
  }

  async checkNow(): Promise<void> {
    const config = vscode.workspace.getConfiguration("codexCustom");
    const codex = config.get<string>("codexExecutable", "").trim() || "codex";
    const npm = config.get<string>("npmExecutable", "").trim() || "npm";
    const [installed, latest] = await Promise.all([
      run(codex, ["--version"]),
      run(npm, ["view", "@openai/codex", "version"])
    ]);
    const current = installed.match(/\d+\.\d+\.\d+/)?.[0];
    if (!current || !/^\d+\.\d+\.\d+$/.test(latest)) return;

    const oldParts = current.split(".").map(Number);
    const newParts = latest.split(".").map(Number);
    const newer = newParts.findIndex((part, index) => part !== oldParts[index]);
    if (newer < 0 || newParts[newer] < oldParts[newer]) return;

    const choice = await vscode.window.showInformationMessage(
      `Codex ${latest} is available (installed: ${current}).`,
      "Update Codex"
    );
    if (choice === "Update Codex") {
      const result = await this.updateNow();
      void vscode.window.showInformationMessage(result);
    }
  }

  async updateNow(): Promise<string> {
    const npm = vscode.workspace.getConfiguration("codexCustom")
      .get<string>("npmExecutable", "").trim() || "npm";
    await run(npm, ["install", "-g", "@openai/codex@latest"]);
    return "Codex runtime updated. Restart the sidebar to use the new version.";
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.configurationListener.dispose();
  }
}
