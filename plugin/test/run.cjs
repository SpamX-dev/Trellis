const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { driveUi } = require('./ui.cjs');

/** Выделяет свободный loopback-порт только для Chromium изолированного тестового окна. */
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/**
 * Запускает проверку доверия напрямую: test-electron всегда добавляет
 * --disable-workspace-trust и потому не может подтвердить Restricted Mode.
 * Использует тот же изолированный профиль и ограничивает жизнь дочернего хоста.
 */
function runUntrusted(options) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.vscodeExecutablePath, [
      ...options.launchArgs,
      `--extensionDevelopmentPath=${options.extensionDevelopmentPath}`,
      `--extensionTestsPath=${options.extensionTestsPath}`,
    ], { env: { ...process.env, ...options.extensionTestsEnv }, windowsHide: true });
    child.stdout.pipe(options.stdout, { end: false });
    child.stderr.pipe(options.stderr, { end: false });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Untrusted host timed out')); }, 60_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error(`Untrusted host exited with code ${code}`));
    });
  });
}

/**
 * Запускает интеграционные проверки в отдельном профиле редактора.
 * Поддерживает установленный VS Code / Cursor и распакованный VSIX;
 * временные файлы сохраняются для диагностики, рабочий профиль не используется.
 */
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trellis-test-'));
  const first = path.join(root, 'first', 'Проект & docs %20 #plus+');
  const second = path.join(root, 'second', 'Проект & docs %20 #plus+');
  await fs.mkdir(first, { recursive: true });
  await fs.mkdir(second, { recursive: true });
  await fs.mkdir(path.join(first, 'nested'));
  await fs.writeFile(path.join(first, 'nested', 'fixture.txt'), 'unchanged');
  const workspace = path.join(root, 'Trellis.code-workspace');
  await fs.writeFile(workspace, JSON.stringify({ folders: [{ path: first }], settings: {} }));
  const userData = path.join(root, 'user-data');
  await fs.mkdir(path.join(userData, 'User'), { recursive: true });
  const settings = {
    'workbench.startupEditor': 'none',
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
    'security.workspace.trust.enabled': false,
    'window.dialogStyle': 'custom',
    'files.simpleDialog.enable': true,
    'workbench.colorTheme': 'Default Dark Modern',
  };
  console.log(`Trellis test artifacts: ${root}`);
  const executable = process.env.TRELLIS_TEST_EXECUTABLE || await downloadAndUnzipVSCode();
  for (const phase of ['single', 'main', 'reopen', 'untrusted']) {
    await fs.writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({ ...settings,
      'workbench.colorTheme': phase === 'reopen' ? 'Default Light Modern' : settings['workbench.colorTheme'],
      'security.workspace.trust.enabled': phase === 'untrusted',
      'security.workspace.trust.startupPrompt': 'never',
    }));
    await fs.writeFile(path.join(root, 'ui-request.json'), 'null');
    const port = await freePort();
    const log = createWriteStream(path.join(root, `${phase}-host.log`));
    let stopped = false;
    let uiTask;
    try {
      const options = {
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
          TRELLIS_TEST_ROOT: root,
          TRELLIS_TEST_PHASE: phase,
          TRELLIS_TEST_RESULT_PATH: path.join(root, `${phase}-result.json`),
        },
        launchArgs: [
          phase === 'single' ? first : workspace,
          '--user-data-dir', userData,
          '--extensions-dir', path.join(root, 'extensions'),
          '--disable-extensions',
          '--skip-welcome',
          '--skip-release-notes',
          '--locale=en',
          ...(phase === 'untrusted' ? [] : ['--disable-workspace-trust']),
          '--disable-updates',
          `--remote-debugging-port=${port}`,
          '--remote-debugging-address=127.0.0.1',
        ],
      };
      const test = phase === 'untrusted' ? runUntrusted(options) : runTests(options);
      uiTask = driveUi({ root, port, second, stopped: () => stopped });
      // Ошибки драйвера доводятся до общего результата, без необработанного rejection.
      uiTask.catch(() => {});
      await test;
      console.log(await fs.readFile(path.join(root, `${phase}-result.json`), 'utf8'));
    } finally {
      stopped = true;
      await uiTask;
      await new Promise(resolve => log.end(resolve));
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
