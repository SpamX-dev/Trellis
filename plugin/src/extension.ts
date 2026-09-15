import * as vscode from 'vscode';
import { HomePanel } from './ide/homePanel';
import { WorkspaceTree } from './ide/workspaceTree';

/**
 * Точка композиции расширения: связывает команды и представления редактора.
 * Владение ресурсами передаёт контексту VS Code; анализ кода и управление
 * внешним движком не относятся к ответственности этого слоя.
 */
export function activate(context: vscode.ExtensionContext): void {
  const home = new HomePanel(context.extensionUri, context.extension.packageJSON.version);
  const tree = new WorkspaceTree();
  context.subscriptions.push(
    home,
    tree,
    vscode.commands.registerCommand('trellis.openHome', () => home.show()),
    vscode.window.createTreeView('trellis.workspace', { treeDataProvider: tree, showCollapseAll: false }),
  );
}
