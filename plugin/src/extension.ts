import * as vscode from 'vscode';
import { HomePanel } from './ide/homePanel';
import { WorkspaceTree } from './ide/workspaceTree';
import { WorkspaceProjects } from './ide/workspaceProjects';

/**
 * Точка композиции расширения: связывает команды и представления редактора.
 * Владение ресурсами передаёт контексту VS Code; анализ кода и управление
 * внешним движком не относятся к ответственности этого слоя.
 */
export function activate(context: vscode.ExtensionContext): void {
  const version = context.extension.packageJSON.version as string;
  const projects = new WorkspaceProjects(version);
  const home = new HomePanel();
  const tree = new WorkspaceTree(projects);
  context.subscriptions.push(
    projects,
    home,
    tree,
    vscode.commands.registerCommand('trellis.openHome', () => home.show()),
    vscode.commands.registerCommand('trellis.selectProject', async (uri?: unknown) => {
      if (uri === undefined) {
        const picked = await vscode.window.showQuickPick(projects.projects.map(project => ({
          label: project.name, description: project.path, detail: project.access.message, uri: project.uri,
        })), { placeHolder: 'Выберите проект текущего workspace' });
        uri = picked?.uri;
      }
      return projects.select(uri)?.uri.toString();
    }),
    vscode.commands.registerCommand('trellis.revealProject', (uri: unknown) => projects.reveal(uri)),
    vscode.commands.registerCommand('trellis.refreshProjects', () => projects.refresh()),
    vscode.commands.registerCommand('trellis.showLog', () => projects.showLog()),
    vscode.window.createTreeView('trellis.workspace', { treeDataProvider: tree, showCollapseAll: false }),
  );
}
