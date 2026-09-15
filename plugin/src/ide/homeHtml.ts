/**
 * Снимок данных для стартовой вкладки, независимый от API редактора и движка.
 * Имена и пути считаются недоверенным текстом; URI стилей и CSP задаёт хост.
 */
export interface HomeContent {
  readonly version: string;
  readonly cssUri: string;
  readonly cspSource: string;
  readonly folders: readonly { readonly name: string; readonly path: string }[];
}

/** Экранирует текст и значения HTML-атрибутов, включая имена папок workspace. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

/**
 * Формирует полную HTML-страницу без скриптов, сети и динамических command URI.
 * Отвечает только за представление переданного снимка; не читает workspace.
 */
export function renderHomeHtml(content: HomeContent): string {
  const folders = content.folders.map(folder => `<li class="folder">
    <span class="folder-icon" aria-hidden="true">↳</span>
    <div><h3>${escapeHtml(folder.name)}</h3><p class="path">${escapeHtml(folder.path)}</p></div>
  </li>`).join('');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(content.cspSource)};">
  <link rel="stylesheet" href="${escapeHtml(content.cssUri)}">
  <title>Trellis</title>
</head>
<body>
  <main>
    <header><span class="brand">TRELLIS</span><span class="version">v${escapeHtml(content.version)}</span></header>
    <h1>Рабочая область</h1>
    <p class="intro">Ваши проекты в одном месте.</p>
    <section aria-labelledby="folders-heading">
      <div class="section-heading"><h2 id="folders-heading">Папки проектов</h2><span class="count">${content.folders.length}</span></div>
      ${content.folders.length ? `<ul>${folders}</ul>` : '<div class="empty"><h3>Начните с папки проекта</h3><p>Добавьте папку, чтобы увидеть её в рабочей области Trellis.</p></div>'}
      <a class="button" href="command:workbench.action.addRootFolder">Добавить папку</a>
    </section>
    <footer>Список обновляется вместе с рабочей областью редактора.</footer>
  </main>
</body>
</html>`;
}
