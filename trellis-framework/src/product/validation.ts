import {
  addIssue,
  knownFields,
  optionalString,
  readArray,
  readObject,
  readString,
  requiredString,
} from '../validation.js';
import type { ParseResult, ValidationIssue } from '../validation.js';
import type {
  DocumentSource,
  FunctionalRequirement,
  NonFunctionalRequirement,
  NonFunctionalRequirementKind,
  Product,
  ProductDocument,
  UserStory,
} from './model.js';

/** Идентификатор документа и ссылки допускает только переносимые символы. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Общие ключи четырёх продуктовых документов без наследования их моделей. */
const COMMON_KEYS = ['id', 'type', 'name', 'summary', 'group', 'sources', 'gaps'];

/** Промежуточные прочитанные поля; наружу выдаются только полностью проверенные документы. */
interface CommonFields {
  id?: string;
  name?: string;
  summary?: string;
  group?: string[];
  sources?: DocumentSource[];
  gaps?: string[];
}

/** Проверяет форму идентификатора, не изменяя его значение. */
function checkId(value: string, path: string, issues: ValidationIssue[]): void {
  if (!ID_PATTERN.test(value)) addIssue(issues, 'invalid_id', path, 'Недопустимый формат идентификатора.');
}

/** Читает обязательный идентификатор документа или ссылки. */
function requiredId(object: Record<string, unknown>, key: string, issues: ValidationIssue[]): string | undefined {
  const id = requiredString(object, key, '$', issues);
  if (id !== undefined) checkId(id, `$.${key}`, issues);
  return id;
}

/** Читает список строк; пустота допустима, если список необязателен. */
function readStrings(
  object: Record<string, unknown>, key: string, issues: ValidationIssue[], required = false, unique = false,
): string[] | undefined {
  const path = `$.${key}`;
  if (!Object.hasOwn(object, key)) {
    if (required) addIssue(issues, 'required', path, 'Обязательное поле отсутствует.');
    return undefined;
  }
  const raw = readArray(object[key], path, issues);
  if (!raw) return undefined;
  if (required && raw.length === 0) addIssue(issues, 'empty_array', path, 'Список должен содержать хотя бы один элемент.');
  const values: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const itemPath = `${path}[${index}]`;
    const text = readString(item, itemPath, issues);
    if (text === undefined) continue;
    if (unique && seen.has(text)) addIssue(issues, 'duplicate_value', itemPath, 'Повтор значения в списке.');
    seen.add(text);
    values.push(text);
  }
  return values;
}

/** Читает список ссылок с проверкой формы ID и повторов. */
function readReferences(object: Record<string, unknown>, key: string, issues: ValidationIssue[]): string[] | undefined {
  const path = `$.${key}`;
  if (!Object.hasOwn(object, key)) return undefined;
  const raw = readArray(object[key], path, issues);
  if (!raw) return undefined;
  const values: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const itemPath = `${path}[${index}]`;
    const id = readString(item, itemPath, issues);
    if (id === undefined) continue;
    checkId(id, itemPath, issues);
    if (seen.has(id)) addIssue(issues, 'duplicate_value', itemPath, 'Повтор ссылки в списке.');
    seen.add(id);
    values.push(id);
  }
  return values;
}

/** Читает вложенные источники, проверяя ключи и строковые значения каждого. */
function readSources(object: Record<string, unknown>, issues: ValidationIssue[]): DocumentSource[] | undefined {
  if (!Object.hasOwn(object, 'sources')) return undefined;
  const raw = readArray(object.sources, '$.sources', issues);
  if (!raw) return undefined;
  const sources: DocumentSource[] = [];
  for (const [index, item] of raw.entries()) {
    const path = `$.sources[${index}]`;
    const source = readObject(item, path, issues);
    if (!source) continue;
    knownFields(source, new Set(['location', 'quote']), path, issues);
    const location = requiredString(source, 'location', path, issues);
    const quote = optionalString(source, 'quote', path, issues);
    if (location !== undefined) sources.push({ location, ...(quote === undefined ? {} : { quote }) });
  }
  return sources;
}

/** Читает общие поля, сохраняя необязательные значения только при их наличии. */
function readCommon(object: Record<string, unknown>, issues: ValidationIssue[]): CommonFields {
  const id = requiredId(object, 'id', issues);
  const name = requiredString(object, 'name', '$', issues);
  const summary = optionalString(object, 'summary', '$', issues);
  const group = readStrings(object, 'group', issues, false, true);
  const sources = readSources(object, issues);
  const gaps = readStrings(object, 'gaps', issues);
  return {
    id,
    name,
    ...(summary === undefined ? {} : { summary }),
    ...(group === undefined ? {} : { group }),
    ...(sources === undefined ? {} : { sources }),
    ...(gaps === undefined ? {} : { gaps }),
  };
}

/** Разбирает документ Product и его границу. */
function readProduct(object: Record<string, unknown>, issues: ValidationIssue[]): Product | undefined {
  knownFields(object, new Set([...COMMON_KEYS, 'purpose', 'boundary']), '$', issues);
  const { id, name, ...optional } = readCommon(object, issues);
  const purpose = requiredString(object, 'purpose', '$', issues);
  const boundary = requiredString(object, 'boundary', '$', issues);
  if (issues.length || id === undefined || name === undefined || purpose === undefined || boundary === undefined) return undefined;
  return { id, type: 'product', name, ...optional, purpose, boundary };
}

/** Разбирает пользовательскую историю с текстовой ролью. */
function readUserStory(object: Record<string, unknown>, issues: ValidationIssue[]): UserStory | undefined {
  knownFields(object, new Set([...COMMON_KEYS, 'product_ref', 'actor', 'goal', 'benefit']), '$', issues);
  const { id, name, ...optional } = readCommon(object, issues);
  const productRef = requiredId(object, 'product_ref', issues);
  const actor = requiredString(object, 'actor', '$', issues);
  const goal = requiredString(object, 'goal', '$', issues);
  const benefit = requiredString(object, 'benefit', '$', issues);
  if (issues.length || id === undefined || name === undefined || productRef === undefined ||
      actor === undefined || goal === undefined || benefit === undefined) return undefined;
  return { id, type: 'user-story', name, ...optional, product_ref: productRef, actor, goal, benefit };
}

/** Разбирает функциональное требование, критерии и ссылки на US и NFR. */
function readFunctionalRequirement(
  object: Record<string, unknown>, issues: ValidationIssue[],
): FunctionalRequirement | undefined {
  knownFields(object, new Set([
    ...COMMON_KEYS, 'product_ref', 'statement', 'trigger', 'story_refs', 'constraint_refs', 'acceptance_criteria',
  ]), '$', issues);
  const { id, name, ...optional } = readCommon(object, issues);
  const productRef = requiredId(object, 'product_ref', issues);
  const statement = requiredString(object, 'statement', '$', issues);
  const trigger = optionalString(object, 'trigger', '$', issues);
  const storyRefs = readReferences(object, 'story_refs', issues);
  const constraintRefs = readReferences(object, 'constraint_refs', issues);
  const criteria = readStrings(object, 'acceptance_criteria', issues, true);
  if (issues.length || id === undefined || name === undefined || productRef === undefined ||
      statement === undefined || criteria === undefined) return undefined;
  return {
    id, type: 'functional-requirement', name, ...optional, product_ref: productRef, statement,
    ...(trigger === undefined ? {} : { trigger }),
    ...(storyRefs === undefined ? {} : { story_refs: storyRefs }),
    ...(constraintRefs === undefined ? {} : { constraint_refs: constraintRefs }),
    acceptance_criteria: criteria,
  };
}

/** Читает категорию NFR из закрытого списка допустимых значений. */
function readKind(object: Record<string, unknown>, issues: ValidationIssue[]): NonFunctionalRequirementKind | undefined {
  const kind = requiredString(object, 'kind', '$', issues);
  switch (kind) {
    case 'performance':
    case 'reliability':
    case 'security':
    case 'usability':
    case 'maintainability':
    case 'compatibility':
    case 'other':
      return kind;
    case undefined:
      return undefined;
    default:
      addIssue(issues, 'invalid_value', '$.kind', 'Неизвестная категория NFR.');
      return undefined;
  }
}

/** Разбирает нефункциональное требование с измерением и условиями. */
function readNonFunctionalRequirement(
  object: Record<string, unknown>, issues: ValidationIssue[],
): NonFunctionalRequirement | undefined {
  knownFields(object, new Set([
    ...COMMON_KEYS, 'product_ref', 'kind', 'statement', 'measure', 'target', 'context',
  ]), '$', issues);
  const { id, name, ...optional } = readCommon(object, issues);
  const productRef = requiredId(object, 'product_ref', issues);
  const kind = readKind(object, issues);
  const statement = requiredString(object, 'statement', '$', issues);
  const measure = requiredString(object, 'measure', '$', issues);
  const target = requiredString(object, 'target', '$', issues);
  const context = requiredString(object, 'context', '$', issues);
  if (issues.length || id === undefined || name === undefined || productRef === undefined ||
      kind === undefined || statement === undefined || measure === undefined ||
      target === undefined || context === undefined) return undefined;
  return { id, type: 'non-functional-requirement', name, ...optional, product_ref: productRef,
    kind, statement, measure, target, context };
}

/** Разбирает неизвестное значение в один из четырёх продуктовых документов. */
export function parseProductDocument(value: unknown): ParseResult<ProductDocument> {
  const issues: ValidationIssue[] = [];
  const object = readObject(value, '$', issues);
  if (!object) return { ok: false, issues };
  const type = requiredString(object, 'type', '$', issues);
  let document: ProductDocument | undefined;
  switch (type) {
    case 'product':
      document = readProduct(object, issues);
      break;
    case 'user-story':
      document = readUserStory(object, issues);
      break;
    case 'functional-requirement':
      document = readFunctionalRequirement(object, issues);
      break;
    case 'non-functional-requirement':
      document = readNonFunctionalRequirement(object, issues);
      break;
    case undefined:
      break;
    default:
      addIssue(issues, 'invalid_value', '$.type', 'Неизвестный тип продуктового документа.');
  }
  if (issues.length || document === undefined) return { ok: false, issues };
  return { ok: true, value: document };
}
