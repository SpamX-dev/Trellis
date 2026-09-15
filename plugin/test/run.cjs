const { runTests } = require('@vscode/test-electron');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Запускает интеграционные проверки в отдельном профиле редактора.
 * Поддерживает установленный VS Code / Cursor и распакованный VSIX;
 * временные файлы сохраняются для диагностики, рабочий профиль не используется.
 */
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trellis-test-'));
  const first = path.join(root, 'Project A');
  const second = path.join(root, 'Project B & docs');
  await fs.mkdir(first);
  await fs.mkdir(second);
  const workspace = path.join(root, 'Trellis.code-workspace');
  await fs.writeFile(workspace, JSON.stringify({ folders: [{ path: first }], settings: {} }));
  const userData = path.join(root, 'user-data');
  await fs.mkdir(path.join(userData, 'User'), { recursive: true });
  await fs.writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none',
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
    'security.workspace.trust.enabled': false,
  }));
  console.log(`Trellis test artifacts: ${root}`);
  const executable = process.env.TRELLIS_TEST_EXECUTABLE;
  const log = createWriteStream(path.join(root, 'host.log'));
  try {
    await runTests({
      stdout: log,
      stderr: log,
      ...(executable ? { vscodeExecutablePath: executable } : {}),
      extensionDevelopmentPath: process.env.TRELLIS_TEST_EXTENSION_PATH || path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, '../out/test-build/test/suite/index.js'),
      extensionTestsEnv: {
        // CLI-окружение может принудительно запускать Electron как Node.js.
        // Для тестового окна отключаем этот режим только в дочернем процессе.
        ELECTRON_RUN_AS_NODE: undefined,
        VSCODE_IPC_HOOK_CLI: undefined,
        TRELLIS_TEST_SECOND_FOLDER: second,
        TRELLIS_TEST_RESULT_PATH: path.join(root, 'result.json'),
      },
      launchArgs: [
        workspace,
        '--user-data-dir', userData,
        '--extensions-dir', path.join(root, 'extensions'),
        '--disable-extensions',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        '--disable-updates',
      ],
    });
    console.log(await fs.readFile(path.join(root, 'result.json'), 'utf8'));
  } finally {
    await new Promise(resolve => log.end(resolve));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
