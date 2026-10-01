import type { TaskInput, TaskResult, TaskStatus } from './agent.js';

/** Коды ошибок формы данных, используемые при разборе внешних значений. */
export type ValidationCode =
  | 'required'
  | 'invalid_type'
  | 'empty_string'
  | 'invalid_id'
  | 'invalid_value'
  | 'unknown_field'
  | 'duplicate_value'
  | 'missing_reference'
  | 'empty_array';

/** Ошибка проверки с путём к конкретному полю или элементу массива. */
export interface ValidationIssue {
  /** Машинный код причины отказа. */
  code: ValidationCode;
  /** Путь от корня входного значения; корень обозначается символом `$`. */
  path: string;
  /** Человекочитаемое объяснение на русском языке. */
  message: string;
}

/** Успешный разбор либо полный список найденных ошибок без частичного значения. */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

/** Накапливает ошибку, не прерывая проверку соседних полей. */
export function addIssue(issues: ValidationIssue[], code: ValidationCode, path: string, message: string): void {
  issues.push({ code, path, message });
}

/** Читает объект из неизвестного значения, исключая массивы и null. */
export function readObject(value: unknown, path: string, issues: ValidationIssue[]): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    addIssue(issues, 'invalid_type', path, 'Ожидается объект.');
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** Читает содержательную строку без изменения пробелов и регистра. */
export function readString(value: unknown, path: string, issues: ValidationIssue[]): string | undefined {
  if (typeof value !== 'string') {
    addIssue(issues, 'invalid_type', path, 'Ожидается строка.');
    return undefined;
  }
  if (value.trim().length === 0) {
    addIssue(issues, 'empty_string', path, 'Строка не должна быть пустой.');
    return undefined;
  }
  return value;
}

/** Читает массив из неизвестного значения без изменения его элементов. */
export function readArray(value: unknown, path: string, issues: ValidationIssue[]): unknown[] | undefined {
  if (!Array.isArray(value)) {
    addIssue(issues, 'invalid_type', path, 'Ожидается массив.');
    return undefined;
  }
  return value;
}

/** Читает обязательное строковое поле и отдельно сообщает об отсутствии ключа. */
export function requiredString(
  object: Record<string, unknown>, key: string, path: string, issues: ValidationIssue[],
): string | undefined {
  const fieldPath = `${path}.${key}`;
  if (!Object.hasOwn(object, key)) {
    addIssue(issues, 'required', fieldPath, 'Обязательное поле отсутствует.');
    return undefined;
  }
  return readString(object[key], fieldPath, issues);
}

/** Читает необязательное строковое поле, проверяя его тип при наличии ключа. */
export function optionalString(
  object: Record<string, unknown>, key: string, path: string, issues: ValidationIssue[],
): string | undefined {
  return Object.hasOwn(object, key) ? readString(object[key], `${path}.${key}`, issues) : undefined;
}

/** Сообщает о полях вне явного набора допустимых ключей. */
export function knownFields(
  object: Record<string, unknown>, allowed: ReadonlySet<string>, path: string, issues: ValidationIssue[],
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) addIssue(issues, 'unknown_field', `${path}.${key}`, 'Неизвестное поле.');
  }
}

/** Разбирает неизвестный вход задачи без добавления или исправления полей. */
export function parseTaskInput(value: unknown): ParseResult<TaskInput> {
  const issues: ValidationIssue[] = [];
  const object = readObject(value, '$', issues);
  if (!object) return { ok: false, issues };
  knownFields(object, new Set(['request']), '$', issues);
  const request = requiredString(object, 'request', '$', issues);
  if (issues.length || request === undefined) return { ok: false, issues };
  return { ok: true, value: { request } };
}

/** Разбирает неизвестный отчёт исполнителя без подтверждения прохождения гейтов. */
export function parseTaskResult(value: unknown): ParseResult<TaskResult> {
  const issues: ValidationIssue[] = [];
  const object = readObject(value, '$', issues);
  if (!object) return { ok: false, issues };
  knownFields(object, new Set(['status', 'summary']), '$', issues);
  const rawStatus = requiredString(object, 'status', '$', issues);
  const summary = requiredString(object, 'summary', '$', issues);
  let status: TaskStatus | undefined;
  switch (rawStatus) {
    case 'completed':
    case 'needs_input':
    case 'failed':
      status = rawStatus;
      break;
    case undefined:
      break;
    default:
      addIssue(issues, 'invalid_value', '$.status', 'Неизвестный статус задачи.');
  }
  if (issues.length || status === undefined || summary === undefined) return { ok: false, issues };
  return { ok: true, value: { status, summary } };
}
