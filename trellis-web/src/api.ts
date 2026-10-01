/** Подтверждённый участник для отображения. UI не выводит из этого типа полномочия на сервере. */
export interface Actor { kind: 'human' | 'agent'; id: string; username?: string; name?: string; admin?: boolean }

/** Человек, уже входивший через Keycloak и поэтому доступный для назначения. */
export interface Person { id: string; username: string; display_name: string }

/** Агентская учётная запись без секретного токена в ответе списка. */
export interface Agent { id: string; name: string; enabled: boolean }

/** Каталожные метаданные проекта без адреса серверного Git-хранилища. */
export interface Project { id: string; name: string; description: string; owner_person_id: string; state: string }

/** Коммит, показанный в истории доступной ветки main. */
export interface Commit { oid: string; date: string; author: string; subject: string }

/** Элемент дерева точного коммита; symlink остаётся Git blob с mode 120000. */
export interface TreeEntry { oid: string; name: string; mode: string; type: string }

/**
 * Единая точка HTTP-вызова: все операции передают проверенный OIDC-токен,
 * обрабатывают ошибку сервера и никогда не принимают локальное решение о праве.
 */
export async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json() as { message?: string | string[] };
      if (body.message) message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    } catch { /* Пустой ответ оставляет HTTP-статус. */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
