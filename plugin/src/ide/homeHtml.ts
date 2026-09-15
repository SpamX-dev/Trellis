/**
 * Формирует пустую вкладку, зарезервированную под Grafel. Не принимает данные
 * workspace, не содержит действий и не загружает ресурсы. Тему задаёт Webview
 * редактора; жизненным циклом вкладки управляет HomePanel.
 */
export function renderHomeHtml(): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none';">
  <title>Trellis</title>
</head>
<body></body>
</html>`;
}
