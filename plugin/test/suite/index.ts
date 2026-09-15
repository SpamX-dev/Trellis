import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FolderAccess } from '../../src/ide/folderAccess';

/** Ожидает наблюдаемое состояние хоста с конечным сроком, без фиксированной задержки успеха. */
async function until(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** Возвращает реальные Webview-вкладки Trellis текущего окна. */
function homeTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs)
    .filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'Trellis');
}

/**
 * Дожидается события завершения изменения workspace перед следующим вызовом API.
 * Оптимистически обновлённый workspaceFolders ещё не означает готовность редактора
 * принять следующую мутацию, что особенно заметно в тестах асинхронных гонок.
 */
async function changeFolders(start: number, deleteCount: number, ...folders: { uri: vscode.Uri }[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { listener.dispose(); reject(new Error('Workspace update timed out')); }, 10_000);
    const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearTimeout(timer); listener.dispose(); resolve();
    });
    if (!vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...folders)) {
      clearTimeout(timer); listener.dispose(); reject(new Error('Workspace update rejected'));
    }
  });
}

/** Согласует проверки хоста с UI-драйвером только через временный каталог теста. */
async function ui(step: string): Promise<void> {
  const root = process.env.TRELLIS_TEST_ROOT!;
  await vscode.commands.executeCommand('workbench.view.extension.trellis');
  await fs.writeFile(path.join(root, 'ui-request.json'), JSON.stringify({ step }));
  await until(async () => {
    try {
      const result = JSON.parse(await fs.readFile(path.join(root, 'ui-result.json'), 'utf8'));
      if (result.step !== step) return false;
      assert.equal(result.error, undefined, result.error);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return false;
      throw error;
    }
  }, `UI: ${step}`);
}

/**
 * Проверяет команды и workspace в изолированном Extension Host. Компоненты
 * загружаются из dist проверяемого расширения, в том числе из распакованного
 * VSIX: тестовая компиляция не подменяет код поставки. Все изменения относятся
 * к временным папкам и профилю; Grafel и пользовательские исходники не используются.
 */
export async function run(): Promise<void> {
  const cases: string[] = [];
  const extension = vscode.extensions.getExtension('spamx-dev.trellis');
  assert.ok(extension);
  await extension.activate();
  assert.ok(extension.isActive);
  const { WorkspaceProjects } = require(path.join(extension.extensionPath, 'dist/ide/workspaceProjects')) as typeof import('../../src/ide/workspaceProjects');
  const { WorkspaceTree } = require(path.join(extension.extensionPath, 'dist/ide/workspaceTree')) as typeof import('../../src/ide/workspaceTree');
  const { checkFolderAccess } = require(path.join(extension.extensionPath, 'dist/ide/folderAccess')) as typeof import('../../src/ide/folderAccess');
  const root = process.env.TRELLIS_TEST_ROOT!;
  const second = vscode.Uri.file(process.env.TRELLIS_TEST_SECOND_FOLDER!);
  const phase = process.env.TRELLIS_TEST_PHASE;
  const projects = new WorkspaceProjects(extension.packageJSON.version);
  const tree = new WorkspaceTree(projects);
  try {
    await projects.refresh();
    if (phase === 'single') {
      assert.equal(projects.projects.length, 1);
      assert.equal(vscode.workspace.workspaceFile, undefined);
      await vscode.commands.executeCommand('trellis.openHome');
      await ui('single-folder');
      cases.push('single-folder window reads the actual editor root');
    } else if (phase === 'reopen' || phase === 'untrusted') {
      assert.equal(projects.projects.length, 2);
      assert.deepEqual(projects.projects.map(p => p.uri), vscode.workspace.workspaceFolders!.map(f => f.uri.toString()));
      assert.ok(projects.projects.every(p => !p.selected && p.access.state === 'available'));
      await vscode.commands.executeCommand('trellis.openHome');
      await until(() => homeTabs().length === 1, 'home after restart');
      if (phase === 'untrusted') {
        assert.equal(vscode.workspace.isTrusted, false);
        projects.select(second.toString());
        await assert.rejects(projects.resolveAnalysisProject(), /доверие/);
        cases.push('untrusted workspace: shell works, analysis preparation rejected');
      } else {
        await ui('reopened-workspace');
        cases.push('saved workspace restored after editor restart; selection not persisted');
      }
    } else {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('trellis.selectProject'));
      // Редактор сам добавляет команды перемещения/скрытия view; они не управляют проектами.
      assert.ok(!commands.some(c => /^trellis\.(remove|delete|untrack)/i.test(c)));
      assert.equal(homeTabs().length, 0);
      await vscode.commands.executeCommand('workbench.view.extension.trellis');
      await vscode.commands.executeCommand('trellis.openHome');
      await until(() => homeTabs().length === 1, 'first home tab');
      await vscode.commands.executeCommand('trellis.openHome');
      assert.equal(homeTabs().length, 1);
      await vscode.window.tabGroups.close(homeTabs());
      await until(() => homeTabs().length === 0, 'closed home tab');
      await vscode.commands.executeCommand('trellis.openHome');
      await until(() => homeTabs().length === 1, 'reopened home tab');
      cases.push('activation, sidebar, singleton home lifecycle, no removal command');

      assert.equal(projects.projects.length, 1);
      const first = vscode.workspace.workspaceFolders![0];
      const firstUri = first.uri.toString();
      assert.equal(projects.select(first.name), undefined);
      assert.equal(projects.select(vscode.Uri.joinPath(first.uri, 'nested').toString()), undefined);
      assert.ok(projects.select(firstUri));
      assert.equal((await projects.resolveAnalysisProject()).uri.toString(), firstUri);
      await ui('cancel-add');
      assert.equal(projects.projects.length, 1);
      await ui('add-second');
      await until(() => projects.projects.length === 2 && projects.projects.every(p => p.access.state === 'available'), 'native addition');
      assert.equal(projects.projects[0].name, projects.projects[1].name);
      assert.notEqual(projects.projects[0].path, projects.projects[1].path);
      assert.deepEqual(tree.getChildren().filter(i => i.resourceUri).map(i => i.id), [firstUri, second.toString()]);
      assert.equal(await vscode.commands.executeCommand('trellis.selectProject', second.toString()), second.toString());
      await ui('selected-project');
      cases.push('native add/cancel; same-name folders agree in Explorer/sidebar; palette and tree selection by URI');

      let changes = 0;
      const listener = tree.onDidChangeTreeData(() => changes++);
      projects.select(second.toString());
      await changeFolders(1, 1);
      await until(() => projects.projects.length === 1 && changes > 0, 'removed selection');
      assert.ok(projects.projects.every(p => !p.selected));
      await assert.rejects(projects.resolveAnalysisProject(), /Выберите папку/);
      assert.equal(await vscode.commands.executeCommand('trellis.selectProject', second.toString()), undefined);
      await ui('removed-project');
      listener.dispose();

      const missing = vscode.Uri.file(path.join(root, 'missing'));
      const remote = vscode.Uri.parse('trellis-remote://example/project');
      assert.equal((await checkFolderAccess(remote)).state, 'unsupported');
      const file = path.join(root, 'not-a-folder.txt');
      await fs.writeFile(file, 'fixture');
      assert.equal((await checkFolderAccess(vscode.Uri.file(file))).code, 'ENOTDIR');
      await changeFolders(1, 0, { uri: missing }, { uri: remote });
      await until(() => projects.projects.length === 3 && projects.projects.every(p => p.access.state !== 'checking'), 'diagnostics');
      assert.equal(projects.projects[1].access.code, 'ENOENT');
      assert.equal(projects.projects[2].access.state, 'unsupported');
      projects.select(remote.toString());
      await assert.rejects(projects.resolveAnalysisProject(), /локальных/);
      projects.select(missing.toString());
      await assert.rejects(projects.resolveAnalysisProject(), /не найдена/);
      await ui('diagnostics');
      await vscode.commands.executeCommand('workbench.action.closePanel');
      await fs.mkdir(missing.fsPath);
      await projects.refresh();
      assert.equal(projects.projects[1].access.state, 'available');
      await ui('recovery');
      cases.push('removed selection reset; stale URI rejected; diagnostics and recovery via sidebar header; journal command');

      // Задерживаем ответы для воспроизводимой проверки смены выбора и workspace.
      const pending: Array<(result: FolderAccess) => void> = [];
      let block = false;
      const racing = new WorkspaceProjects(extension.packageJSON.version, uri => block
        ? new Promise(resolve => pending.push(resolve)) : checkFolderAccess(uri));
      try {
        await racing.refresh();
        racing.select(firstUri);
        block = true;
        const rejection = assert.rejects(racing.resolveAnalysisProject(), /Выбор проекта изменился/);
        await until(() => pending.length === 1, 'pending analysis access check');
        racing.select(missing.toString());
        pending.shift()!({ state: 'available', message: 'Папка доступна' });
        await rejection;
        const oldRefresh = racing.refresh();
        await until(() => pending.length === 3, 'pending old workspace checks');
        await changeFolders(1, 2);
        await until(() => racing.projects.length === 1, 'workspace changed during check');
        block = false;
        await racing.refresh();
        for (const resolve of pending.splice(0)) resolve({ state: 'unavailable', message: 'Старый ответ' });
        await oldRefresh;
        assert.equal(racing.projects[0].access.state, 'available');
        assert.ok(racing.projects.every(p => !p.selected));
      } finally { racing.dispose(); }
      cases.push('late responses discarded; pending operation never switches project');

      const stalled = new WorkspaceProjects(extension.packageJSON.version, () => new Promise(() => {}), 25);
      const failed = new WorkspaceProjects(extension.packageJSON.version, async () => { throw new Error('private error'); });
      try {
        await stalled.refresh();
        await failed.refresh();
        assert.equal(stalled.projects[0].access.code, 'TIMEOUT');
        assert.equal(failed.projects[0].access.code, 'IO_ERROR');
        assert.ok(!failed.projects[0].access.message.includes('private error'));
      } finally { stalled.dispose(); failed.dispose(); }
      cases.push('filesystem timeout and unexpected failure have finite, sanitized diagnostics');

      assert.equal(await vscode.commands.executeCommand('trellis.selectProject', { encodedUri: '!invalid' }), undefined);
      await changeFolders(0, 1);
      await until(() => projects.projects.length === 0, 'empty workspace');
      assert.equal(tree.getChildren().filter(i => i.resourceUri).length, 0);
      await ui('empty-workspace');
      await changeFolders(0, 0, { uri: first.uri }, { uri: second });
      await until(() => projects.projects.length === 2, 'restore roots for restart');
      assert.equal(await fs.readFile(file, 'utf8'), 'fixture');
      assert.equal(await fs.readFile(path.join(first.uri.fsPath, 'nested', 'fixture.txt'), 'utf8'), 'unchanged');
      cases.push('empty sidebar and blank home; malformed selection rejected; source files preserved');
    }
    await vscode.window.tabGroups.close(homeTabs());
    const result = { app: vscode.env.appName, vscodeVersion: vscode.version, extensionVersion: extension.packageJSON.version,
      extensionPath: extension.extensionPath, phase, cases };
    await fs.writeFile(process.env.TRELLIS_TEST_RESULT_PATH!, JSON.stringify(result, null, 2));
    console.log(`TRELLIS_TEST_PASS ${JSON.stringify(result)}`);
  } finally {
    tree.dispose();
    projects.dispose();
  }
}
