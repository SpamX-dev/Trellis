import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { renderHomeHtml } from '../../src/ide/homeHtml';
import { WorkspaceTree } from '../../src/ide/workspaceTree';

/** Ожидает наблюдаемое состояние хоста с ограничением времени, без фиксированной задержки успеха. */
async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** Возвращает реальные Webview-вкладки Trellis, зарегистрированные в текущем окне редактора. */
function homeTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs)
    .filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'Trellis');
}

/**
 * Проверяет поведение расширения внутри настоящего Extension Host.
 * Работает только с временным workspace тестового запуска; не индексирует код,
 * не использует Grafel и не меняет пользовательскую конфигурацию редактора.
 */
export async function run(): Promise<void> {
  const cases: string[] = [];
  const extension = vscode.extensions.getExtension('spamx-dev.trellis');
  assert.ok(extension, 'Trellis must be discoverable by Extension Host');
  assert.equal(extension.packageJSON.version, '0.1.0');
  await extension.activate();
  assert.ok(extension.isActive);
  assert.ok((await vscode.commands.getCommands(true)).includes('trellis.openHome'));
  assert.equal(homeTabs().length, 0, 'Activation must not open a tab automatically');
  await vscode.commands.executeCommand('workbench.view.extension.trellis');
  cases.push('extension activation and sidebar command');

  await vscode.commands.executeCommand('trellis.openHome');
  await until(() => homeTabs().length === 1, 'first home tab');
  await vscode.commands.executeCommand('trellis.openHome');
  assert.equal(homeTabs().length, 1, 'Repeated command must reuse the tab');
  assert.ok(await vscode.window.tabGroups.close(homeTabs()[0]));
  await until(() => homeTabs().length === 0, 'closed home tab');
  await vscode.commands.executeCommand('trellis.openHome');
  await until(() => homeTabs().length === 1, 'reopened home tab');
  cases.push('home tab open, reuse, close and reopen');

  const tree = new WorkspaceTree();
  try {
    assert.equal(vscode.workspace.workspaceFolders?.length, 1);
    assert.equal(tree.getChildren().filter(item => item.resourceUri).length, 1);
    const secondFolder = process.env.TRELLIS_TEST_SECOND_FOLDER;
    assert.ok(secondFolder);
    let changes = 0;
    const listener = tree.onDidChangeTreeData(() => changes++);
    try {
      assert.ok(vscode.workspace.updateWorkspaceFolders(1, 0, { uri: vscode.Uri.file(secondFolder) }));
      await until(() => changes > 0 && vscode.workspace.workspaceFolders?.length === 2, 'added workspace folder');
      const folders = tree.getChildren().filter(item => item.resourceUri);
      assert.equal(folders.length, 2);
      assert.equal(folders[1].label, 'Project B & docs');
      assert.equal(folders[1].command?.command, 'revealInExplorer');
      assert.equal((folders[1].command?.arguments?.[0] as vscode.Uri).toString(), vscode.Uri.file(secondFolder).toString());
      const beforeRemoval = changes;
      assert.ok(vscode.workspace.updateWorkspaceFolders(1, 1));
      await until(() => changes > beforeRemoval && vscode.workspace.workspaceFolders?.length === 1, 'removed workspace folder');
      assert.equal(tree.getChildren().filter(item => item.resourceUri).length, 1);
    } finally {
      listener.dispose();
    }
    assert.equal(homeTabs().length, 1, 'Workspace changes must preserve the home tab');
  } finally {
    tree.dispose();
  }
  cases.push('workspace folder addition, removal and tree refresh');

  const html = renderHomeHtml({
    version: '0.1.0', cssUri: 'vscode-webview://test/home.css', cspSource: 'vscode-webview://test',
    folders: [{ name: '<script>alert("x")</script> & project', path: 'C:\\path\\"quoted"' }],
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; project'));
  assert.ok(html.includes('&quot;quoted&quot;'));
  assert.ok(html.includes("default-src 'none'"));
  const empty = renderHomeHtml({ version: '0.1.0', cssUri: 'local.css', cspSource: 'local:', folders: [] });
  assert.ok(empty.includes('Начните с папки проекта'));
  assert.ok(empty.includes('command:workbench.action.addRootFolder'));
  cases.push('empty workspace and escaping of untrusted folder names');

  await vscode.window.tabGroups.close(homeTabs());
  const result = { app: vscode.env.appName, vscodeVersion: vscode.version, extensionPath: extension.extensionPath, cases };
  const resultPath = process.env.TRELLIS_TEST_RESULT_PATH;
  if (resultPath) await fs.writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(`TRELLIS_TEST_PASS ${JSON.stringify(result)}`);
}
