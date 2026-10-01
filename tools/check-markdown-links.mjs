/** Проверяет локальные Markdown-ссылки в поддерживаемой документации репозитория. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set(['.git', 'node_modules', 'dist', 'dist-web', 'var', 'old']);
const issues = [];

/** Собирает Markdown-файлы без перехода по символическим ссылкам и архивному каталогу. */
function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink() || excluded.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}

/** Проверяет относительные цели ссылок вне блоков кода; сетевые адреса не запрашивает. */
function checkFile(file) {
  const content = readFileSync(file, 'utf8').replace(/^\s*\x60{3}[\s\S]*?^\s*\x60{3}\s*$/gm, '');
  const pattern = /\[[^\]]+\]\((?:<([^>]+)>|([^\s)]+))\)/g;
  for (const match of content.matchAll(pattern)) {
    const target = match[1] ?? match[2];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    let location;
    try {
      location = decodeURIComponent(target.split('#')[0]);
    } catch {
      issues.push(`${relative(root, file)}: неверная кодировка ссылки ${target}`);
      continue;
    }
    if (location && !existsSync(resolve(dirname(file), location))) {
      issues.push(`${relative(root, file)}: не найдена ссылка ${target}`);
    }
  }
}

for (const file of markdownFiles(root)) checkFile(file);
if (issues.length) {
  console.error(issues.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Локальные Markdown-ссылки: OK');
}
