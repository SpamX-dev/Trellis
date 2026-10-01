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
  BusinessAttribute,
  BusinessAttributeValueType,
  BusinessObject,
  BusinessProcess,
  BusinessProcessStep,
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

/** Читает список ссылок с проверкой формы ID и повторов; basePath нужен для вложенных списков. */
function readReferences(
  object: Record<string, unknown>, key: string, issues: ValidationIssue[], basePath = '$',
): string[] | undefined {
  const path = `${basePath}.${key}`;
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

/** Разбирает функциональное требование, критерии и ссылки на US, BO и NFR. */
function readFunctionalRequirement(
  object: Record<string, unknown>, issues: ValidationIssue[],
): FunctionalRequirement | undefined {
  knownFields(object, new Set([
    ...COMMON_KEYS, 'product_ref', 'statement', 'trigger', 'story_refs', 'object_refs',
    'constraint_refs', 'acceptance_criteria',
  ]), '$', issues);
  const { id, name, ...optional } = readCommon(object, issues);
  const productRef = requiredId(object, 'product_ref', issues);
  const statement = requiredString(object, 'statement', '$', issues);
  const trigger = optionalString(object, 'trigger', '$', issues);
  const storyRefs = readReferences(object, 'story_refs', issues);
  const objectRefs = readReferences(object, 'object_refs', issues);
  const constraintRefs = readReferences(object, 'constraint_refs', issues);
  const criteria = readStrings(object, 'acceptance_criteria', issues, true);
  if (issues.length || id === undefined || name === undefined || productRef === undefined ||
      statement === undefined || criteria === undefined) return undefined;
  return {
    id, type: 'functional-requirement', name, ...optional, product_ref: productRef, statement,
    ...(trigger === undefined ? {} : { trigger }),
    ...(storyRefs === undefined ? {} : { story_refs: storyRefs }),
    ...(objectRefs === undefined ? {} : { object_refs: objectRefs }),
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

/** Читает предметный вид значения атрибута из закрытого набора. */
function readAttributeValueType(
  object: Record<string, unknown>, path: string, issues: ValidationIssue[],
): BusinessAttributeValueType | undefined {
  const raw = requiredString(object, 'value_type', path, issues);
  switch (raw) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'date':
    case 'object':
    case 'array':
      return raw;
    case undefined:
      return undefined;
    default:
      addIssue(issues, 'invalid_value', `${path}.value_type`, 'Неизвестный предметный вид значения атрибута.');
      return undefined;
  }
}

/** Читает обязательный непустой список атрибутов бизнес-объекта. */
function readAttributes(object: Record<string, unknown>, issues: ValidationIssue[]): BusinessAttribute[] | undefined {
  if (!Object.hasOwn(object, 'attributes')) {
    addIssue(issues, 'required', '$.attributes', 'Обязательное поле отсутствует.');
    return undefined;
  }
  const raw = readArray(object.attributes, '$.attributes', issues);
  if (!raw) return undefined;
  if (raw.length === 0) addIssue(issues, 'empty_array', '$.attributes', 'Список должен содержать хотя бы один элемент.');
  const attributes: BusinessAttribute[] = [];
  for (const [index, item] of raw.entries()) {
    const path = `$.attributes[${index}]`;
    const attribute = readObject(item, path, issues);
    if (!attribute) continue;
    knownFields(attribute, new Set(['name', 'meaning', 'value_type']), path, issues);
    const name = requiredString(attribute, 'name', path, issues);
    const meaning = requiredString(attribute, 'meaning', path, issues);
    const valueType = readAttributeValueType(attribute, path, issues);
    if (name !== undefined && meaning !== undefined && valueType !== undefined) {
      attributes.push({ name, meaning, value_type: valueType });
    }
  }
  return attributes;
}

/** Разбирает предметный объект с определением и атрибутами. */
function readBusinessObject(object: Record<string, unknown>, issues: ValidationIssue[]): BusinessObject | undefined {
  knownFields(object, new Set([...COMMON_KEYS, 'product_ref', 'definition', 'attributes']), '$', issues);
  const { id, name, ...optional } = readCommon(object, issues);
  const productRef = requiredId(object, 'product_ref', issues);
  const definition = requiredString(object, 'definition', '$', issues);
  const attributes = readAttributes(object, issues);
  if (issues.length || id === undefined || name === undefined || productRef === undefined ||
      definition === undefined || attributes === undefined) return undefined;
  return { id, type: 'business-object', name, ...optional, product_ref: productRef, definition, attributes };
}

/** Читает список локальных ключей следующих шагов с проверкой формы и повторов. */
function readStepKeys(
  step: Record<string, unknown>, key: string, basePath: string, issues: ValidationIssue[],
): string[] | undefined {
  const path = `${basePath}.${key}`;
  if (!Object.hasOwn(step, key)) return undefined;
  const raw = readArray(step[key], path, issues);
  if (!raw) return undefined;
  const values: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const itemPath = `${path}[${index}]`;
    const value = readString(item, itemPath, issues);
    if (value === undefined) continue;
    checkId(value, itemPath, issues);
    if (seen.has(value)) addIssue(issues, 'duplicate_value', itemPath, 'Повтор ключа в списке.');
    seen.add(value);
    values.push(value);
  }
  return values;
}

/** Читает обязательный непустой список шагов и проверяет их локальные связи. */
function readSteps(object: Record<string, unknown>, issues: ValidationIssue[]): BusinessProcessStep[] | undefined {
  if (!Object.hasOwn(object, 'steps')) {
    addIssue(issues, 'required', '$.steps', 'Обязательное поле отсутствует.');
    return undefined;
  }
  const raw = readArray(object.steps, '$.steps', issues);
  if (!raw) return undefined;
  if (raw.length === 0) addIssue(issues, 'empty_array', '$.steps', 'Список должен содержать хотя бы один элемент.');
  const steps: BusinessProcessStep[] = [];
  const keys = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const path = `$.steps[${index}]`;
    const step = readObject(item, path, issues);
    if (!step) continue;
    knownFields(step, new Set(['key', 'name', 'actor', 'requirement_refs', 'next_steps']), path, issues);
    const key = requiredString(step, 'key', path, issues);
    if (key !== undefined) {
      checkId(key, `${path}.key`, issues);
      if (keys.has(key)) addIssue(issues, 'duplicate_value', `${path}.key`, 'Повтор локального ключа шага.');
      keys.add(key);
    }
    const name = requiredString(step, 'name', path, issues);
    const actor = optionalString(step, 'actor', path, issues);
    const requirementRefs = readReferences(step, 'requirement_refs', issues, path);
    const nextSteps = readStepKeys(step, 'next_steps', path, issues);
    if (key !== undefined && name !== undefined) {
      steps.push({
        key, name,
        ...(actor === undefined ? {} : { actor }),
        ...(requirementRefs === undefined ? {} : { requirement_refs: requirementRefs }),
        ...(nextSteps === undefined ? {} : { next_steps: nextSteps }),
      });
    }
  }
  // Локальные продолжения должны вести на существующие ключи шагов процесса.
  const knownKeys = new Set(steps.map(step => step.key));
  for (const [index, step] of steps.entries()) {
    for (const [refIndex, target] of (step.next_steps ?? []).entries()) {
      if (!knownKeys.has(target)) {
        addIssue(issues, 'missing_reference', `$.steps[${index}].next_steps[${refIndex}]`,
          `Ключ "${target}" не найден среди шагов процесса.`);
      }
    }
  }
  return steps;
}

/** Разбирает бизнес-процесс с целью и шагами. */
function readBusinessProcess(object: Record<string, unknown>, issues: ValidationIssue[]): BusinessProcess | undefined {
  knownFields(object, new Set([...COMMON_KEYS, 'product_ref', 'goal', 'steps']), '$', issues);
  const { id, name, ...optional } = readCommon(object, issues);
  const productRef = requiredId(object, 'product_ref', issues);
  const goal = requiredString(object, 'goal', '$', issues);
  const steps = readSteps(object, issues);
  if (issues.length || id === undefined || name === undefined || productRef === undefined ||
      goal === undefined || steps === undefined) return undefined;
  return { id, type: 'business-process', name, ...optional, product_ref: productRef, goal, steps };
}

/** Разбирает неизвестное значение в один из шести продуктовых документов. */
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
    case 'business-object':
      document = readBusinessObject(object, issues);
      break;
    case 'business-process':
      document = readBusinessProcess(object, issues);
      break;
    case undefined:
      break;
    default:
      addIssue(issues, 'invalid_value', '$.type', 'Неизвестный тип продуктового документа.');
  }
  if (issues.length || document === undefined) return { ok: false, issues };
  return { ok: true, value: document };
}
