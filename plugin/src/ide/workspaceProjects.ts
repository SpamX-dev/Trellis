import * as vscode from 'vscode';
import { checkFolderAccess, FolderAccess } from './folderAccess';

/**
 * Снимок одного корня workspace для боковой панели. URI задаёт идентичность;
 * имя и полный путь служат отображению и считаются недоверенным текстом.
 * Доступность папки не означает готовность индекса или поддержку языка.
 */
export interface WorkspaceProject {
  readonly uri: string;
  readonly name: string;
  readonly path: string;
  readonly selected: boolean;
  readonly access: FolderAccess;
}

/**
 * Общий контекст боковой панели и будущих операций анализа в одном окне.
 * Состав и порядок всегда читает из workspaceFolders, хранит только временные
 * результаты проверки доступа и выбранный URI. Не сохраняет реестр проектов,
 * не меняет workspace, не запускает движок и не наблюдает за исходниками.
 * Поколения проверок исключают поздние ответы после смены workspace/dispose;
 * разрешение операции повторно проверяет папку, доверие и исходный выбор.
 */
export class WorkspaceProjects implements vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;
  private readonly access = new Map<string, FolderAccess>();
  private selectedUri: string | undefined;
  private selectionRevision = 0;
  private refreshRevision = 0;
  private disposed = false;
  private readonly workspaceListener: vscode.Disposable;
  private readonly log = vscode.window.createOutputChannel('Trellis');
  private readonly logLines: string[] = [];

  constructor(
    private readonly version: string,
    private readonly probe: (uri: vscode.Uri) => Promise<FolderAccess> = checkFolderAccess,
    private readonly accessTimeoutMs = 5000,
  ) {
    this.workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.refresh(); });
    void this.refresh();
  }

  get projects(): readonly WorkspaceProject[] {
    return (vscode.workspace.workspaceFolders ?? []).map(folder => ({
      uri: folder.uri.toString(), name: folder.name,
      path: folder.uri.scheme === 'file' ? folder.uri.fsPath : folder.uri.toString(true),
      selected: folder.uri.toString() === this.selectedUri,
      access: this.access.get(folder.uri.toString()) ?? { state: 'checking', message: 'Проверка доступности папки…' },
    }));
  }

  /** Принимает только точный URI текущего корня; вложенный путь и имя не являются идентификатором. */
  select(uri: unknown): vscode.WorkspaceFolder | undefined {
    const folder = this.find(uri);
    if (!folder || this.disposed) return undefined;
    if (this.selectedUri !== folder.uri.toString()) {
      this.selectedUri = folder.uri.toString();
      this.selectionRevision++;
      this.changes.fire();
    }
    return folder;
  }

  /** Обновляет только диагностику; список и выбор не подменяются результатами асинхронного обхода. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const revision = ++this.refreshRevision;
    if (!this.find(this.selectedUri)) {
      this.selectedUri = undefined;
      this.selectionRevision++;
    }
    this.access.clear();
    this.changes.fire();
    await Promise.all((vscode.workspace.workspaceFolders ?? []).map(async folder => {
      const result = await this.check(folder.uri);
      if (this.disposed || revision !== this.refreshRevision || !this.find(folder.uri.toString())) return;
      this.access.set(folder.uri.toString(), result);
      this.record('Проверка доступности папки', folder.uri, result.code ?? result.state);
      this.changes.fire();
    }));
  }

  /**
   * Граница будущей команды анализа: возвращает проверенный корень либо отказ.
   * Захватывает исходный URI до ожидания; смена выбора/удаление корня отменяет
   * разрешение, не переключая начатую операцию на другой одноимённый проект.
   * Фактический запуск и обработка последующих ошибок принадлежат вызывающему слою.
   */
  async resolveAnalysisProject(): Promise<vscode.WorkspaceFolder> {
    const folder = this.find(this.selectedUri);
    if (!folder || this.disposed) throw new Error('Выберите папку текущего workspace в Trellis.');
    if (!vscode.workspace.isTrusted) throw new Error('Для анализа подтвердите доверие к workspace в редакторе.');
    const selectionRevision = this.selectionRevision;
    const refreshRevision = this.refreshRevision;
    const result = await this.check(folder.uri);
    if (this.disposed || selectionRevision !== this.selectionRevision || !this.find(folder.uri.toString())) {
      throw new Error('Выбор проекта изменился. Выберите папку и повторите операцию.');
    }
    if (!vscode.workspace.isTrusted) throw new Error('Для анализа подтвердите доверие к workspace в редакторе.');
    if (refreshRevision === this.refreshRevision) {
      this.access.set(folder.uri.toString(), result);
      this.changes.fire();
    }
    this.record('Подготовка проекта к анализу', folder.uri, result.code ?? result.state);
    const projectPath = folder.uri.scheme === 'file' ? folder.uri.fsPath : folder.uri.toString(true);
    if (result.state !== 'available') throw new Error(`${folder.name} (${projectPath}): ${result.message}`);
    return folder;
  }

  showLog(): void {
    this.log.show(true);
  }

  /** Показывает выбранный корень в Explorer; отказ остаётся в журнале без повторяющихся уведомлений. */
  async reveal(uri: unknown): Promise<string | undefined> {
    const folder = this.select(uri);
    if (!folder) return undefined;
    try {
      await vscode.commands.executeCommand('revealInExplorer', folder.uri);
    } catch {
      this.record('Переход к папке в Explorer', folder.uri, 'REVEAL_FAILED');
      this.showLog();
    }
    return folder.uri.toString();
  }

  private find(uri: unknown): vscode.WorkspaceFolder | undefined {
    return typeof uri === 'string'
      ? vscode.workspace.workspaceFolders?.find(folder => folder.uri.toString() === uri)
      : undefined;
  }

  /**
   * Ограничивает ожидание файловой системы пятью секундами по умолчанию.
   * Поздний ответ не меняет UI; probe сам закрывает полученный дескриптор даже
   * после тайм-аута. Неожиданный отказ преобразуется в безопасную диагностику.
   */
  private async check(uri: vscode.Uri): Promise<FolderAccess> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.probe(uri)).catch((): FolderAccess => ({
          state: 'unavailable', code: 'IO_ERROR',
          message: 'Не удалось проверить папку. Восстановите доступ и повторите проверку.',
        })),
        new Promise<FolderAccess>(resolve => {
          timer = setTimeout(() => resolve({
            state: 'unavailable', code: 'TIMEOUT',
            message: 'Проверка папки превысила время ожидания. Проверьте диск и доступ, затем повторите проверку.',
          }), this.accessTimeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  /** Ограничивает журнал сотней записей; не пишет исходники, стеки и удалённые URI с возможными секретами. */
  private record(operation: string, uri: vscode.Uri, result: string): void {
    const project = uri.scheme === 'file' ? uri.fsPath : `${uri.scheme}:`;
    this.logLines.push(JSON.stringify({ time: new Date().toISOString(), trellis: this.version, operation, project, result }));
    if (this.logLines.length > 100) this.logLines.shift();
    this.log.clear();
    this.log.appendLine(this.logLines.join('\n'));
  }

  dispose(): void {
    this.disposed = true;
    this.workspaceListener.dispose();
    this.changes.dispose();
    this.log.dispose();
  }
}
