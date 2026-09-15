import { opendir } from 'node:fs/promises';
import type { Uri } from 'vscode';

/**
 * Доступность корня workspace, независимая от состояния индекса и движка.
 * Причина и следующее действие предназначены для боковой панели; код ошибки
 * содержит только категорию отказа, без содержимого файлов и текста исключений.
 */
export interface FolderAccess {
  readonly state: 'checking' | 'available' | 'unavailable' | 'unsupported';
  readonly message: string;
  readonly code?: string;
}

/**
 * Проверяет возможность открыть локальный каталог без чтения исходников.
 * Нелокальные схемы не обращаются к провайдеру файловой системы: MVP анализирует
 * только file URI. Проверка доступа не доказывает поддержку языка движком.
 */
export async function checkFolderAccess(uri: Uri): Promise<FolderAccess> {
  if (uri.scheme !== 'file') {
    return {
      state: 'unsupported', code: 'UNSUPPORTED_SCHEME',
      message: 'Анализ доступен только для локальных папок. Откройте локальную копию проекта.',
    };
  }
  try {
    const directory = await opendir(uri.fsPath);
    await directory.close();
    return { state: 'available', message: 'Папка доступна' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    switch (code) {
      case 'ENOENT':
        return { state: 'unavailable', code, message: 'Папка не найдена. Восстановите её или измените папки workspace в Explorer, затем повторите проверку.' };
      case 'ENOTDIR':
        return { state: 'unavailable', code, message: 'Путь не является папкой. Откройте каталог проекта через Explorer.' };
      case 'EACCES':
      case 'EPERM':
        return { state: 'unavailable', code, message: 'Нет доступа к папке. Проверьте разрешения и повторите проверку.' };
      default:
        return { state: 'unavailable', code: 'IO_ERROR', message: 'Не удалось открыть папку. Проверьте диск и доступ, затем повторите проверку.' };
    }
  }
}
