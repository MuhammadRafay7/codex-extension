import * as vscode from "vscode";
import { CodexSidebarProvider } from "./CodexSidebarProvider";
import { CodexRuntimeUpdater } from "./codexRuntimeUpdater";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new CodexSidebarProvider(context.extensionUri, context.globalState);
  const updater = new CodexRuntimeUpdater();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CodexSidebarProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand("codexCustom.openSidebar", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.codexCustom");
    }),
    vscode.commands.registerCommand("codexCustom.openChat", () => {
      provider.openChat();
    }),
    vscode.commands.registerCommand("codexCustom.updateRuntime", async () => {
      try {
        const result = await updater.updateNow();
        vscode.window.showInformationMessage(`Codex: ${result}`);
      } catch (error) {
        vscode.window.showErrorMessage(
          `Codex runtime update failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }),
    provider,
    updater
  );
}

export function deactivate(): void {}
