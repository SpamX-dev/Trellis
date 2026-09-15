import * as vscode from 'vscode';
import { WorkspaceProjects } from './workspaceProjects';

/**
 * Представляет папки текущего workspace средствами штатного дерева редактора.
 * Получает порядок, выбор и диагностику из общего контекста WorkspaceProjects.
 * Не читает файлы и не владеет контекстом; освобождает только свою подписку.
 */
export class WorkspaceTree implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;
  private readonly projectListener: vscode.Disposable;

  constructor(private readonly projects: WorkspaceProjects) {
    this.projectListener = projects.onDidChange(() => this.changes.fire());
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(): vscode.TreeItem[] {
    const folders = this.projects.projects.map(folder => {
      const item = new vscode.TreeItem(folder.name);
      item.id = folder.uri;
      item.resourceUri = vscode.Uri.parse(folder.uri);
      item.iconPath = new vscode.ThemeIcon(folder.access.state === 'available' ? 'folder' : 'warning');
      const status = `${folder.selected ? 'Выбран · ' : ''}${folder.access.message}`;
      const accessLabel = { checking: 'Проверка…', available: 'Доступна', unavailable: 'Недоступна', unsupported: 'Анализ недоступен' }[folder.access.state];
      item.description = `${folder.selected ? 'Выбран · ' : ''}${accessLabel} · ${folder.path}`;
      item.tooltip = `${folder.name}\n${folder.path}\n${status}\nИндекс: не проиндексирован`;
      item.accessibilityInformation = { label: `${folder.name}, ${folder.path}, ${status}, не проиндексирован` };
      item.command = { command: 'trellis.revealProject', title: 'Выбрать проект и показать в Explorer', arguments: [folder.uri] };
      return item;
    });

    const add = new vscode.TreeItem('Добавить папку…');
    add.id = 'addFolder';
    add.iconPath = new vscode.ThemeIcon('add');
    add.command = { command: 'workbench.action.addRootFolder', title: 'Добавить папку' };
    const empty = new vscode.TreeItem('Нет папок — добавьте папку проекта');
    empty.id = 'empty';
    return [...(folders.length ? folders : [empty]), add];
  }

  dispose(): void {
    this.projectListener.dispose();
    this.changes.dispose();
  }
}
