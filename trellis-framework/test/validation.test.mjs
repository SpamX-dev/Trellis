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
  story_refs: [story.id], object_refs: ['BO-001'], constraint_refs: [nfr.id],
  acceptance_criteria: ['Без подтверждения уведомления не отправляются.'],
};
const bo = {
  id: 'BO-001', type: 'business-object', name: 'Уведомление',
  product_ref: product.id, definition: 'Сообщение, доставляемое получателю.',
  attributes: [{ name: 'канал', meaning: 'Способ доставки.', value_type: 'string' }],
};
const bp = {
  id: 'BP-001', type: 'business-process', name: 'Доставка уведомления',
  product_ref: product.id, goal: 'Доставить уведомление.',
  steps: [
    { key: 'confirm', name: 'Подтвердить адрес', actor: 'Пользователь', next_steps: ['send'] },
    { key: 'send', name: 'Передать сообщение', requirement_refs: [fr.id] },
  ],
};

/** Сверяет машинный код и точный путь ошибки независимо от других находок. */
function expectIssue(result, code, path) {
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.code === code && issue.path === path),
    JSON.stringify(result.issues));
}

test('все шесть документов возвращаются с типизированной формой и без изменения входа', () => {
  for (const document of [product, story, fr, nfr, bo, bp]) {
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
  expectIssue(parseProductDocument({ ...product, type: 'stakeholder' }), 'invalid_value', '$.type');
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
  expectIssue(parseProductDocument({ ...fr, object_refs: ['BO-001', 'BO-001'] }),
    'duplicate_value', '$.object_refs[1]');
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

test('атрибуты бизнес-объекта проверяются на каждом уровне', () => {
  expectIssue(parseProductDocument({ ...bo, definition: '   ' }), 'empty_string', '$.definition');
  expectIssue(parseProductDocument({ ...bo, attributes: [] }), 'empty_array', '$.attributes');
  const { attributes, ...missingAttributes } = bo;
  expectIssue(parseProductDocument(missingAttributes), 'required', '$.attributes');
  expectIssue(parseProductDocument({ ...bo, attributes: [{ name: 'канал', meaning: 'Способ.', value_type: 'uuid' }] }),
    'invalid_value', '$.attributes[0].value_type');
  expectIssue(parseProductDocument({ ...bo, attributes: [{ name: 7, meaning: 'Способ.', value_type: 'string' }] }),
    'invalid_type', '$.attributes[0].name');
  expectIssue(parseProductDocument({ ...bo, attributes: [{ name: 'канал', meaning: 'Способ.', value_type: 'string', extra: true }] }),
    'unknown_field', '$.attributes[0].extra');
});

test('шаги процесса требуют уникальные ключи и существующие продолжения', () => {
  expectIssue(parseProductDocument({ ...bp, steps: [] }), 'empty_array', '$.steps');
  const duplicateKeys = {
    ...bp,
    steps: [
      { key: 'send', name: 'Первый' },
      { key: 'send', name: 'Второй' },
    ],
  };
  expectIssue(parseProductDocument(duplicateKeys), 'duplicate_value', '$.steps[1].key');
  const danglingNext = {
    ...bp,
    steps: [{ key: 'confirm', name: 'Подтвердить', next_steps: ['unknown'] }],
  };
  expectIssue(parseProductDocument(danglingNext), 'missing_reference', '$.steps[0].next_steps[0]');
  expectIssue(parseProductDocument({ ...bp, steps: [{ key: 'send', name: 'Передать', next_steps: ['send', 'send'] }] }),
    'duplicate_value', '$.steps[0].next_steps[1]');
  expectIssue(parseProductDocument({ ...bp, steps: [{ key: 'BAD KEY', name: 'Передать' }] }),
    'invalid_id', '$.steps[0].key');
  expectIssue(parseProductDocument({ ...bp, steps: [{ key: 'send', name: 'Передать', requirement_refs: ['BAD ID'] }] }),
    'invalid_id', '$.steps[0].requirement_refs[0]');
  expectIssue(parseProductDocument({ ...bp, steps: [{ key: 'send', name: 'Передать', unknown: true }] }),
    'unknown_field', '$.steps[0].unknown');
});