import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTaskInput, parseTaskResult } from '@trellis/framework';
import { parseProductDocument } from '@trellis/framework/product';

const product = {
  id: 'PRODUCT-001', type: 'product', name: 'Сервис уведомлений',
  purpose: 'Доставлять уведомления.', boundary: 'Отправка сообщений.',
};
const story = {
  id: 'US-001', type: 'user-story', name: 'Получение сообщения',
  product_ref: product.id, actor: 'Пользователь', goal: 'Получить сообщение.', benefit: 'Быть в курсе.',
};
const nfr = {
  id: 'NFR-001', type: 'non-functional-requirement', name: 'Время отправки',
  product_ref: product.id, kind: 'performance', statement: 'Быстрая отправка.',
  measure: 'Время до передачи.', target: 'Не более 5 секунд.', context: 'При штатной нагрузке.',
};
const fr = {
  id: 'FR-001', type: 'functional-requirement', name: 'Подтверждение адреса',
  product_ref: product.id, statement: 'Включить уведомления после подтверждения.',
  story_refs: [story.id], constraint_refs: [nfr.id],
  acceptance_criteria: ['Без подтверждения уведомления не отправляются.'],
};

/** Сверяет машинный код и точный путь ошибки независимо от других находок. */
function expectIssue(result, code, path) {
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.code === code && issue.path === path),
    JSON.stringify(result.issues));
}

test('все четыре документа возвращаются с типизированной формой и без изменения входа', () => {
  for (const document of [product, story, fr, nfr]) {
    const before = structuredClone(document);
    const result = parseProductDocument(document);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.value, document);
    assert.deepEqual(document, before);
    assert.notEqual(result.value, document);
  }
});

test('необязательные коллекции могут быть пустыми', () => {
  const result = parseProductDocument({ ...fr, group: [], gaps: [], sources: [], story_refs: [], constraint_refs: [] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.group, []);
});

test('текстовые значения не обрезаются и вход не исправляется', () => {
  const input = Object.freeze({ ...product, name: '  Сервис уведомлений  ', group: ['Точное Имя'] });
  const result = parseProductDocument(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.name, input.name);
  assert.deepEqual(result.value.group, ['Точное Имя']);
  assert.notEqual(result.value.group, input.group);
});

test('неверные типы, обязательные поля и неизвестные ключи дают пути к полям', () => {
  expectIssue(parseProductDocument(null), 'invalid_type', '$');
  expectIssue(parseProductDocument({ ...product, type: 'business-rule' }), 'invalid_value', '$.type');
  expectIssue(parseProductDocument({ ...product, legacy: true }), 'unknown_field', '$.legacy');
  expectIssue(parseProductDocument({ ...product, purpose: '   ' }), 'empty_string', '$.purpose');
  expectIssue(parseProductDocument({ ...product, name: 5 }), 'invalid_type', '$.name');
  const { boundary, ...missingBoundary } = product;
  expectIssue(parseProductDocument(missingBoundary), 'required', '$.boundary');
  expectIssue(parseProductDocument({ ...story, actor_ref: 'ACTOR-001' }), 'unknown_field', '$.actor_ref');
});

test('идентификаторы и категория NFR имеют закрытую форму', () => {
  expectIssue(parseProductDocument({ ...product, id: 'BAD ID' }), 'invalid_id', '$.id');
  expectIssue(parseProductDocument({ ...story, product_ref: 'BAD ID' }), 'invalid_id', '$.product_ref');
  expectIssue(parseProductDocument({ ...nfr, kind: 'latency' }), 'invalid_value', '$.kind');
  expectIssue(parseProductDocument({ ...fr, story_refs: ['BAD ID'] }), 'invalid_id', '$.story_refs[0]');
});

test('критерии приёмки FR обязательны и содержат непустые строки', () => {
  expectIssue(parseProductDocument({ ...fr, acceptance_criteria: [] }), 'empty_array', '$.acceptance_criteria');
  expectIssue(parseProductDocument({ ...fr, acceptance_criteria: ['  '] }), 'empty_string', '$.acceptance_criteria[0]');
  const { acceptance_criteria, ...missingCriteria } = fr;
  expectIssue(parseProductDocument(missingCriteria), 'required', '$.acceptance_criteria');
});

test('источники и элементы массивов проверяются на каждом уровне', () => {
  expectIssue(parseProductDocument({ ...product, sources: [{ location: 7 }] }), 'invalid_type', '$.sources[0].location');
  expectIssue(parseProductDocument({ ...product, sources: [{ location: 'Интервью', quote: '' }] }),
    'empty_string', '$.sources[0].quote');
  expectIssue(parseProductDocument({ ...product, sources: [{ location: 'Интервью', extra: true }] }),
    'unknown_field', '$.sources[0].extra');
  expectIssue(parseProductDocument({ ...product, gaps: [42] }), 'invalid_type', '$.gaps[0]');
  expectIssue(parseProductDocument({ ...fr, story_refs: [5] }), 'invalid_type', '$.story_refs[0]');
});

test('группы и ссылки не допускают повторов', () => {
  expectIssue(parseProductDocument({ ...product, group: ['уведомления', 'уведомления'] }),
    'duplicate_value', '$.group[1]');
  expectIssue(parseProductDocument({ ...fr, story_refs: ['US-001', 'US-001'] }),
    'duplicate_value', '$.story_refs[1]');
  expectIssue(parseProductDocument({ ...fr, constraint_refs: ['NFR-001', 'NFR-001'] }),
    'duplicate_value', '$.constraint_refs[1]');
  assert.equal(parseProductDocument({ ...product, group: ['Уведомления', 'уведомления'] }).ok, true);
});

test('несколько ошибок возвращаются вместе без изменения неверного входа', () => {
  const input = Object.freeze({ ...product, purpose: ' ', boundary: 42, group: ['повтор', 'повтор'] });
  const before = structuredClone(input);
  const result = parseProductDocument(input);
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(issue => [issue.code, issue.path]), [
    ['duplicate_value', '$.group[1]'],
    ['empty_string', '$.purpose'],
    ['invalid_type', '$.boundary'],
  ]);
  assert.deepEqual(input, before);
});

test('вход задачи и отчёт исполнителя разбираются отдельно от документов', () => {
  assert.deepEqual(parseTaskInput({ request: 'Опишите продукт' }),
    { ok: true, value: { request: 'Опишите продукт' } });
  assert.deepEqual(parseTaskResult({ status: 'needs_input', summary: 'Нужны ограничения.' }),
    { ok: true, value: { status: 'needs_input', summary: 'Нужны ограничения.' } });
  expectIssue(parseTaskInput({ request: '' }), 'empty_string', '$.request');
  expectIssue(parseTaskInput({ request: 'Задача', documents: [] }), 'unknown_field', '$.documents');
  expectIssue(parseTaskResult({ status: 'done', summary: 'Готово' }), 'invalid_value', '$.status');
  expectIssue(parseTaskResult({ status: 'completed', summary: ' ' }), 'empty_string', '$.summary');
  expectIssue(parseTaskResult({ status: 'completed', summary: 'Готово', documents: [] }),
    'unknown_field', '$.documents');
});
