import * as vscode from 'vscode';
import { renderHomeHtml } from './homeHtml';

/**
 * Управляет единственной пустой вкладкой, зарезервированной под Grafel.
 * Не зависит от контекста проектов и не подписывается на изменения workspace.
 * Вкладка не выполняет скрипты и команды и не загружает локальные ресурсы.
 * Закрытие освобождает её подписку; повторное открытие активирует один экземпляр.
 */
export class HomePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelListener: vscode.Disposable | undefined;

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel('trellis.home', 'Trellis', vscode.ViewColumn.Active, {
      enableScripts: false,
      enableCommandUris: false,
      localResourceRoots: [],
    });
    this.panelListener = this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.panelListener?.dispose();
      this.panelListener = undefined;
    });
    this.panel.webview.html = renderHomeHtml();
  }

  dispose(): void {
    this.panel?.dispose();
    this.panelListener?.dispose();
  }
}
