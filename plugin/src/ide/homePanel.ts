import * as vscode from 'vscode';
import { renderHomeHtml } from './homeHtml';

/**
 * Управляет единственной стартовой вкладкой в окне редактора и её подписками.
 * Получает сведения о папках из VS Code и передаёт их HTML-представлению.
 * Webview использует только локальные стили, без скриптов; разрешена лишь
 * штатная команда добавления папки. Не служит транспортом API Grafel.
 */
export class HomePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelListener: vscode.Disposable | undefined;
  private readonly workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(() => this.render());

  constructor(private readonly extensionUri: vscode.Uri, private readonly version: string) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel('trellis.home', 'Trellis', vscode.ViewColumn.Active, {
      enableScripts: false,
      enableCommandUris: ['workbench.action.addRootFolder'],
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    });
    this.panelListener = this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.panelListener?.dispose();
      this.panelListener = undefined;
    });
    this.render();
  }

  private render(): void {
    if (!this.panel) return;
    const webview = this.panel.webview;
    webview.html = renderHomeHtml({
      version: this.version,
      cssUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'home.css')).toString(),
      cspSource: webview.cspSource,
      folders: (vscode.workspace.workspaceFolders ?? []).map(folder => ({
        name: folder.name,
        path: folder.uri.scheme === 'file' ? folder.uri.fsPath : folder.uri.toString(true),
      })),
    });
  }

  dispose(): void {
    this.workspaceListener.dispose();
    this.panel?.dispose();
    this.panelListener?.dispose();
  }
}
