/**
 * Строгий разбор YAML для документов в Git.
 *
 * Документы хранятся как YAML, но не являются произвольным YAML. Разбор
 * отклоняет конструкции, делающие текст неоднозначным или зависящим от
 * реализации: несколько документов в одном файле, повторяющиеся ключи,
 * якоря и псевдонимы, ключи слияния и теги за пределами базовой схемы
 * YAML 1.2. Отклонение завершает разбор ошибкой с местом нарушения.
 */
import { isAlias, isMap, isPair, isScalar, isSeq, LineCounter, parseAllDocuments, visit } from 'yaml';
import type { Document } from 'yaml';

/** Ошибка строгого разбора YAML с указанием источника и места нарушения. */
export class StrictYamlError extends Error {
  /** Имя источника, например путь файла в снимке. */
  readonly source: string;
  /** Номер строки нарушения, если место известно; отсчёт с единицы. */
  readonly line?: number;
  /** Номер столбца нарушения, если место известно; отсчёт с единицы. */
  readonly column?: number;

  constructor(source: string, reason: string, position?: { line: number; column: number }) {
    const place = position ? `${source}:${position.line}:${position.column}: ` : `${source}: `;
    super(place + reason);
    this.name = 'StrictYamlError';
    this.source = source;
    this.line = position?.line;
    this.column = position?.column;
  }
}

/** Теги базовой схемы YAML 1.2; явные теги за её пределами отклоняются. */
const CORE_TAGS = new Set([
  'tag:yaml.org,2002:str',
  'tag:yaml.org,2002:int',
  'tag:yaml.org,2002:float',
  'tag:yaml.org,2002:bool',
  'tag:yaml.org,2002:null',
  'tag:yaml.org,2002:map',
  'tag:yaml.org,2002:seq',
]);

/** Возвращает позицию смещения в источнике, когда она известна. */
function positionOf(counter: LineCounter, offset?: number): { line: number; column: number } | undefined {
  const position = offset === undefined ? undefined : counter.linePos(offset);
  return position ? { line: position.line, column: position.col } : undefined;
}

/**
 * Отклоняет расширенный синтаксис в дереве документа: якоря, псевдонимы,
 * ключи слияния и теги вне базовой схемы. Прерывается первой же находкой.
 */
function rejectExtendedSyntax(document: Document, counter: LineCounter, source: string): void {
  visit(document.contents, (_, node) => {
    if (isPair(node)) {
      if (isScalar(node.key) && node.key.value === '<<') {
        throw new StrictYamlError(
          source, 'Ключ слияния "<<" недопустим.', positionOf(counter, node.key.range?.[0]),
        );
      }
      return;
    }
    if (isAlias(node)) {
      throw new StrictYamlError(
        source, 'Псевдонимы YAML недопустимы.', positionOf(counter, node.range?.[0]),
      );
    }
    if (isMap(node) || isSeq(node) || isScalar(node)) {
      if (node.anchor !== undefined) {
        throw new StrictYamlError(
          source, 'Якоря YAML недопустимы.', positionOf(counter, node.range?.[0]),
        );
      }
      const tag = node.tag;
      if (tag !== undefined && tag !== '?' && !CORE_TAGS.has(tag)) {
        throw new StrictYamlError(
          source, `Тег YAML "${tag}" недопустим.`, positionOf(counter, node.range?.[0]),
        );
      }
    }
  });
}

/** Разбирает текст как единственный YAML-документ без расширенного синтаксиса. */
export function parseStrictYaml(text: string, source: string): unknown {
  const counter = new LineCounter();
  const documents = parseAllDocuments(text, { lineCounter: counter, strict: true, uniqueKeys: true });
  if (documents.length > 1) {
    throw new StrictYamlError(source, 'Ожидается ровно один документ YAML, найдено несколько.');
  }
  const document = documents[0];
  if (document === undefined) {
    // Пустой файл является потоком без документов и разбирается в null.
    return null;
  }
  // Ошибки синтаксиса и схемы, включая повторяющиеся ключи, приходят в errors.
  const error = document.errors[0];
  if (error) {
    const position = error.linePos?.[0];
    const reason = error.code === 'DUPLICATE_KEY'
      ? 'Повторяющийся ключ в отображении YAML.'
      : error.message.split('\n')[0];
    throw new StrictYamlError(
      source, reason, position ? { line: position.line, column: position.col } : undefined,
    );
  }
  rejectExtendedSyntax(document, counter, source);
  // Псевдонимы уже отклонены; нулевой лимит страхует от их появления в будущем.
  return document.toJS({ maxAliasCount: 0 });
}
