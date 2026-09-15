import * as vscode from 'vscode';

/**
 * Представляет папки текущего workspace средствами штатного дерева редактора.
 * Не читает содержимое файлов и не хранит копию списка: VS Code остаётся
 * источником данных. Владеет подпиской на изменения workspace и освобождает её.
 */
export class WorkspaceTree implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;
  private readonly workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(() => this.changes.fire());

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(): vscode.TreeItem[] {
    const home = new vscode.TreeItem('Открыть Trellis');
    home.id = 'home';
    home.iconPath = new vscode.ThemeIcon('home');
    home.command = { command: 'trellis.openHome', title: 'Открыть Trellis' };

    const folders = (vscode.workspace.workspaceFolders ?? []).map(folder => {
      const item = new vscode.TreeItem(folder.name);
      item.id = folder.uri.toString();
      item.resourceUri = folder.uri;
      item.iconPath = new vscode.ThemeIcon('folder');
      item.tooltip = folder.uri.scheme === 'file' ? folder.uri.fsPath : folder.uri.toString(true);
      item.command = { command: 'revealInExplorer', title: 'Показать в проводнике', arguments: [folder.uri] };
      return item;
    });

    const add = new vscode.TreeItem('Добавить папку…');
    add.id = 'addFolder';
    add.iconPath = new vscode.ThemeIcon('add');
    add.command = { command: 'workbench.action.addRootFolder', title: 'Добавить папку' };
    return [home, ...folders, add];
  }

  dispose(): void {
    this.workspaceListener.dispose();
    this.changes.dispose();
  }
}
