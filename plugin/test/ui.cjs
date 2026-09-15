const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');

/** Ожидает состояние UI или файла с конечным сроком; применяется только тестовым драйвером. */
async function until(predicate, description) {
  const deadline = Date.now() + 20_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`UI timeout: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** Находит документ пустой вкладки Trellis внутри Webview редактора. */
async function home(page) {
  let result;
  await until(async () => {
    for (const frame of page.frames()) {
      if (await frame.locator('html[lang="ru"] > head > title').textContent({ timeout: 200 }).catch(() => '') === 'Trellis') {
        result = frame; return true;
      }
    }
    return false;
  }, 'Trellis webview');
  return result;
}

/** Возвращает строки корневых папок из реального дерева, исключая добавление и пустое состояние. */
function folderRows(page) {
  return page.locator('.part.sidebar').getByRole('treeitem').filter({ hasNotText: /Добавить папку…|Нет папок —/ });
}

/** Проверяет отрисованный список панели, не используя внутренние объекты расширения. */
async function folderCount(page, count) {
  await until(async () => await folderRows(page).count() === count, `${count} sidebar folders`);
}

/** Проверяет отсутствие содержимого и действий во вкладке при любых изменениях workspace. */
async function emptyHome(page) {
  const frame = await home(page);
  assert.equal((await frame.locator('body').innerText()).trim(), '');
  assert.equal(await frame.locator('a, button, input, li').count(), 0);
}

/**
 * Выполняет один сценарий в изолированном окне редактора. Штатный диалог
 * добавления использует files.simpleDialog.enable, чтобы его можно было
 * воспроизводимо проверить с клавиатуры через Chromium редактора.
 */
async function step(page, name, root, second) {
  const sidebar = page.locator('.part.sidebar');
  const refresh = sidebar.getByRole('button', { name: /Проверить доступность папок/ });
  const log = sidebar.getByRole('button', { name: /Открыть журнал/ });
  await refresh.waitFor({ state: 'visible' });
  await log.waitFor({ state: 'visible' });
  assert.equal(await sidebar.getByRole('button', { name: /Открыть Trellis/ }).count(), 0);
  assert.ok(!(await sidebar.innerText()).includes('Открыть Trellis'));
  await emptyHome(page);
  if (name === 'cancel-add' || name === 'add-second') {
    const add = sidebar.getByRole('treeitem').filter({ hasText: 'Добавить папку…' });
    await add.click();
    const dialog = page.locator('.quick-input-widget');
    await dialog.waitFor({ state: 'visible' });
    if (name === 'cancel-add') {
      await fs.writeFile(path.join(root, 'add-dialog.txt'), await dialog.innerText());
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await folderCount(page, 1);
    } else {
      await dialog.locator('input').fill(second + path.sep);
      await page.keyboard.press('Enter');
      // Enter может либо открыть каталог, либо сразу подтвердить уже разрешённый путь.
      try { await dialog.getByRole('button', { name: 'Add', exact: true }).click({ timeout: 1500 }); }
      catch (error) { if (await dialog.isVisible()) throw error; }
      await dialog.waitFor({ state: 'hidden' });
      await folderCount(page, 2);
    }
  } else if (name === 'selected-project') {
    await folderCount(page, 2);
    await until(async () => (await folderRows(page).nth(1).innerText()).includes('Выбран'), 'selected project');
    // Выбираем первый проект с клавиатуры через палитру и штатный QuickPick.
    await page.keyboard.press('Control+Shift+P');
    await page.locator('.quick-input-widget input').fill('>Trellis: Выбрать проект');
    await page.keyboard.press('Enter');
    const picker = page.getByPlaceholder('Выберите проект текущего workspace');
    await picker.waitFor({ state: 'visible' });
    await picker.press('Enter');
    await until(async () => (await folderRows(page).nth(0).innerText()).includes('Выбран'), 'palette selection');
    await page.screenshot({ path: path.join(root, 'selected-dark.png') });
    assert.ok((await sidebar.innerText()).toLowerCase().includes(second.toLowerCase()));
    await sidebar.getByRole('treeitem').filter({ hasText: /second\\Проект & docs/ }).click();
    await until(async () => (await sidebar.innerText()).startsWith('EXPLORER'), 'Explorer reveal');
    const roots = sidebar.getByRole('treeitem').filter({ hasText: 'Проект & docs' });
    await until(async () => await roots.count() === 2, 'Explorer root list');
    await until(async () => await roots.nth(1).getAttribute('aria-selected') === 'true', 'Explorer selected root');
    await page.screenshot({ path: path.join(root, 'explorer.png') });
    await page.keyboard.press('Control+Shift+P');
    await page.locator('.quick-input-widget input').fill('>Trellis: Открыть Trellis');
    await page.keyboard.press('Enter');
  } else if (name === 'removed-project') {
    await folderCount(page, 1);
    assert.ok(!(await sidebar.innerText()).includes('Выбран'));
  } else if (name === 'diagnostics') {
    await folderCount(page, 3);
    await until(async () => (await folderRows(page).nth(1).getAttribute('aria-label')).includes('Папка не найдена'), 'missing folder message');
    assert.ok((await folderRows(page).nth(2).getAttribute('aria-label')).includes('только для локальных папок'));
    await log.click();
    const output = page.locator('.part.panel');
    await until(async () => (await output.innerText()).includes('ENOENT'), 'journal from sidebar header');
    await page.screenshot({ path: path.join(root, 'diagnostics.png') });
  } else if (name === 'recovery') {
    await refresh.click();
    await until(async () => (await folderRows(page).nth(1).getAttribute('aria-label')).includes('Папка доступна'), 'recovered directory');
  } else if (name === 'empty-workspace') {
    await folderCount(page, 0);
    assert.ok((await sidebar.innerText()).includes('Нет папок — добавьте папку проекта'));
    await page.screenshot({ path: path.join(root, 'empty.png') });
  } else if (name === 'reopened-workspace' || name === 'single-folder') {
    await folderCount(page, name === 'single-folder' ? 1 : 2);
    assert.ok(!(await sidebar.innerText()).includes('Выбран'));
    await page.screenshot({ path: path.join(root, `${name}.png`) });
  } else {
    throw new Error(`Unknown UI step: ${name}`);
  }
  await emptyHome(page);
}

/**
 * Обслуживает сценарии Extension Host через loopback CDP тестового окна.
 * Не подключается к рабочему профилю; при отказе сохраняет DOM и screenshot,
 * а завершение Extension Host прерывает ожидание очередного сценария.
 */
async function driveUi({ root, port, second, stopped }) {
  let browser;
  let connectionError;
  try {
    await until(async () => {
      if (stopped()) return true;
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10_000, noDefaults: true });
        return true;
      } catch (error) { connectionError = error; return false; }
    }, 'editor CDP');
  } catch (error) { throw new Error(`${error}\n${connectionError}`); }
  if (!browser) return;
  let last;
  try {
    while (!stopped()) {
      let request;
      try { request = JSON.parse(await fs.readFile(path.join(root, 'ui-request.json'), 'utf8')); }
      catch { /* Хост ещё не запросил следующий сценарий. */ }
      if (request && request.step !== last) {
        last = request.step;
        const page = browser.contexts()[0].pages().find(p => p.url().includes('workbench'));
        if (!page) throw new Error('Editor workbench page not found');
        page.setDefaultTimeout(10_000);
        let error;
        try { await step(page, last, root, second); }
        catch (failure) {
          error = String(failure.stack || failure);
          await fs.writeFile(path.join(root, `${last}-failure.txt`), error + '\n' + await page.locator('body').innerText());
          await fs.writeFile(path.join(root, `${last}-webview.html`), await (await home(page)).content()).catch(() => {});
          await page.screenshot({ path: path.join(root, `${last}-failure.png`) }).catch(() => {});
        }
        await fs.writeFile(path.join(root, 'ui-result.json'), JSON.stringify({ step: last, error }));
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally { await browser.close().catch(() => {}); }
}

module.exports = { driveUi };
