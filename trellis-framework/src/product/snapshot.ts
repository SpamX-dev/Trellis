/**
 * Проверка целостности продуктовой области Git-снимка.
 *
 * Вызывающий компонент передаёт содержимое файлов точной ревизии вместе с
 * путями относительно корня области `documents/product`. Проверка не
 * обращается к файловой системе, не управляет Git и не изменяет входные
 * данные. Размещение области задаёт [план](../../plan.md):
 * `documents/product/<type>/<id>.yaml`, где `<type>` — тип документа,
 * а имя файла совпадает с `id`.
 */
import { parseStrictYaml, StrictYamlError } from '../node/yaml.js';
import type { ValidationCode } from '../validation.js';
import type { Product, ProductDocument } from './model.js';
import { parseProductDocument } from './validation.js';

/** Файл проверяемой продуктовой области с путём относительно её корня. */
export interface SnapshotFile {
  /** Путь с прямыми слэшами в форме `<type>/<id>.yaml`. */
  path: string;
  /** Текст файла; документы хранятся в YAML. */
  content: string;
}

/** Коды ошибок целостности снимка в дополнение к кодам проверки документа. */
export type SnapshotCode =
  | 'invalid_yaml'
  | 'invalid_layout'
  | 'path_conflict'
  | 'duplicate_id'
  | 'multiple_products'
  | 'missing_product'
  | 'missing_reference'
  | 'wrong_reference_type';

/** Ошибка проверки снимка с указанием файла и необязательного поля внутри него. */
export interface SnapshotIssue {
  /** Машинный код причины отказа. */
  code: ValidationCode | SnapshotCode;
  /** Путь файла в проверяемой области; отсутствует для ошибок всего набора. */
  file?: string;
  /** Путь к полю внутри документа от корня `$`; отсутствует для ошибок файла. */
  path?: string;
  /** Человекочитаемое объяснение на русском языке. */
  message: string;
}

/** Проверенный снимок: единственный продукт и все документы области. */
export interface CheckedProductSnapshot {
  /** Единственный документ Product проверяемой области. */
  product: Product;
  /** Все документы области, включая Product, в порядке их путей. */
  documents: ProductDocument[];
}

/** Успешная проверка либо полный список найденных ошибок без частичного значения. */
export type SnapshotCheckResult =
  | { ok: true; value: CheckedProductSnapshot }
  | { ok: false; issues: SnapshotIssue[] };

/** Допустимые имена каталогов размещения шести продуктовых документов. */
const DOCUMENT_TYPES = new Set([
  'product',
  'user-story',
  'functional-requirement',
  'non-functional-requirement',
  'business-object',
  'business-process',
]);

/** Добавляет ошибку уровня файла или всего набора в общий список. */
function addFileIssue(issues: SnapshotIssue[], code: SnapshotCode, file: string | undefined, message: string): void {
  issues.push({ code, ...(file === undefined ? {} : { file }), message });
}

/** Сравнивает файлы по путям для независимого от входного порядка результата. */
function compareFiles(a: SnapshotFile, b: SnapshotFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Извлекает тип и идентификатор из пути размещения `<type>/<id>.yaml`. */
function readLayout(path: string): { type: string; id: string } | undefined {
  if (path.includes('..') || path.startsWith('/')) return undefined;
  const parts = path.split('/');
  if (parts.length !== 2) return undefined;
  const [type, base] = parts;
  if (!base.endsWith('.yaml') || base.length === '.yaml'.length) return undefined;
  return { type, id: base.slice(0, -'.yaml'.length) };
}

/** Записи файлов, прошедших YAML-разбор и проверку формы документа. */
interface ParsedFile {
  path: string;
  document: ProductDocument;
}

/** Сверяет ссылку на продукт с реестром идентификаторов области. */
function checkProductRef(
  ref: string, file: string,
  byId: ReadonlyMap<string, { path: string; type: string }>,
  issues: SnapshotIssue[],
): void {
  const target = byId.get(ref);
  if (target === undefined) {
    addFileIssue(issues, 'missing_reference', file, `Ссылка product_ref ведёт на отсутствующий документ "${ref}".`);
  } else if (target.type !== 'product') {
    addFileIssue(issues, 'wrong_reference_type', file,
      `Ссылка product_ref указывает на документ типа "${target.type}", а не на Product.`);
  }
}

/** Сверяет ссылку списка FR с документом ожидаемого типа. */
function checkRequirementRef(
  ref: string, file: string, field: string, expectedType: string,
  byId: ReadonlyMap<string, { path: string; type: string }>,
  issues: SnapshotIssue[],
): void {
  const target = byId.get(ref);
  if (target === undefined) {
    addFileIssue(issues, 'missing_reference', file, `Ссылка "${field}" ведёт на отсутствующий документ "${ref}".`);
  } else if (target.type !== expectedType) {
    addFileIssue(issues, 'wrong_reference_type', file,
      `Ссылка "${field}" указывает на документ типа "${target.type}", а не "${expectedType}".`);
  }
}

/**
 * Проверяет переданную продуктовую область снимка целиком: строгий YAML,
 * форму каждого документа, размещение путей, уникальность идентификаторов,
 * единственный Product и ссылки между документами. Порядок файлов на входе
 * не влияет на результат.
 */
export function checkProductSnapshot(files: readonly SnapshotFile[]): SnapshotCheckResult {
  const issues: SnapshotIssue[] = [];
  const sorted = [...files].sort(compareFiles);

  // Разбор файлов в порядке путей; конфликтующие пути дальше не разбираются.
  const parsed: ParsedFile[] = [];
  const seenFolders = new Map<string, string>();
  for (const file of sorted) {
    const path = file.path.replaceAll('\\', '/');
    const folded = path.toLowerCase();
    const previous = seenFolders.get(folded);
    if (previous !== undefined) {
      addFileIssue(issues, 'path_conflict', path, `Путь совпадает с "${previous}" без учёта регистра.`);
      continue;
    }
    seenFolders.set(folded, path);

    const layout = readLayout(path);
    if (layout === undefined) {
      addFileIssue(issues, 'invalid_layout', path,
        'Путь не соответствует размещению "documents/product/<type>/<id>.yaml".');
      continue;
    }
    if (!DOCUMENT_TYPES.has(layout.type)) {
      addFileIssue(issues, 'invalid_layout', path, `Неизвестный тип документа "${layout.type}".`);
      continue;
    }

    let value: unknown;
    try {
      value = parseStrictYaml(file.content, path);
    } catch (error) {
      if (error instanceof StrictYamlError) {
        addFileIssue(issues, 'invalid_yaml', path, error.message);
      } else {
        throw error;
      }
      continue;
    }

    const result = parseProductDocument(value);
    if (!result.ok) {
      for (const issue of result.issues) {
        issues.push({ code: issue.code, file: path, path: issue.path, message: issue.message });
      }
      continue;
    }
    const document = result.value;
    if (document.id !== layout.id) {
      addFileIssue(issues, 'invalid_layout', path,
        `Имя файла "${layout.id}.yaml" не совпадает с id документа "${document.id}".`);
    }
    if (document.type !== layout.type) {
      addFileIssue(issues, 'invalid_layout', path,
        `Каталог "${layout.type}" не соответствует типу документа "${document.type}".`);
    }
    parsed.push({ path, document });
  }

  // Реестр идентификаторов в порядке путей; повторные идентификаторы отсеиваются.
  const byId = new Map<string, { path: string; type: string }>();
  const products: { path: string; document: Product }[] = [];
  for (const entry of parsed) {
    const existing = byId.get(entry.document.id);
    if (existing !== undefined) {
      addFileIssue(issues, 'duplicate_id', entry.path,
        `Идентификатор "${entry.document.id}" уже занят файлом "${existing.path}".`);
      continue;
    }
    byId.set(entry.document.id, { path: entry.path, type: entry.document.type });
    if (entry.document.type === 'product') {
      products.push({ path: entry.path, document: entry.document });
    }
  }

  // В проверяемой области должен быть ровно один документ Product.
  const product = products[0];
  if (products.length === 0) {
    addFileIssue(issues, 'missing_product', undefined, 'В проверяемой области нет документа Product.');
  }
  for (const extra of products.slice(1)) {
    addFileIssue(issues, 'multiple_products', extra.path, 'Дополнительный документ Product; ожидается ровно один.');
  }

  // Ссылки должны вести на существующие документы правильного типа.
  for (const entry of parsed) {
    const { document } = entry;
    if (document.type === 'product') continue;
    checkProductRef(document.product_ref, entry.path, byId, issues);
    if (document.type === 'functional-requirement') {
      for (const ref of document.story_refs ?? []) {
        checkRequirementRef(ref, entry.path, 'story_refs', 'user-story', byId, issues);
      }
      for (const ref of document.object_refs ?? []) {
        checkRequirementRef(ref, entry.path, 'object_refs', 'business-object', byId, issues);
      }
      for (const ref of document.constraint_refs ?? []) {
        checkRequirementRef(ref, entry.path, 'constraint_refs', 'non-functional-requirement', byId, issues);
      }
    }
    if (document.type === 'business-process') {
      for (const [stepIndex, step] of document.steps.entries()) {
        for (const ref of step.requirement_refs ?? []) {
          checkRequirementRef(ref, entry.path, `steps[${stepIndex}].requirement_refs`, 'functional-requirement', byId, issues);
        }
      }
    }
  }

  if (issues.length || product === undefined) return { ok: false, issues };
  return { ok: true, value: { product: product.document, documents: parsed.map(entry => entry.document) } };
}
