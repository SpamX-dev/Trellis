import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStrictYaml, StrictYamlError } from '@trellis/framework/node';
import { checkProductSnapshot } from '@trellis/framework/product';

const productYaml = `id: PRODUCT-001
type: product
name: Сервис уведомлений
purpose: Доставлять уведомления.
boundary: Отправка сообщений.
`;
const storyYaml = `id: US-001
type: user-story
name: Получение сообщения
product_ref: PRODUCT-001
actor: Пользователь
goal: Получить сообщение.
benefit: Быть в курсе.
`;
const nfrYaml = `id: NFR-001
type: non-functional-requirement
name: Время отправки
product_ref: PRODUCT-001
kind: performance
statement: Быстрая отправка.
measure: Время до передачи.
target: Не более 5 секунд.
context: При штатной нагрузке.
`;
const frYaml = `id: FR-001
type: functional-requirement
name: Подтверждение адреса
product_ref: PRODUCT-001
statement: Включить уведомления после подтверждения.
story_refs: [US-001]
object_refs: [BO-001]
constraint_refs: [NFR-001]
acceptance_criteria:
  - Без подтверждения уведомления не отправляются.
`;
const boYaml = `id: BO-001
type: business-object
name: Уведомление
product_ref: PRODUCT-001
definition: Сообщение, доставляемое получателю.
attributes:
  - name: канал
    meaning: Способ доставки.
    value_type: string
`;
const bpYaml = `id: BP-001
type: business-process
name: Доставка уведомления
product_ref: PRODUCT-001
goal: Доставить уведомление.
steps:
  - key: confirm_address
    name: Подтвердить адрес
    requirement_refs: [FR-001]
    next_steps: [send]
  - key: send
    name: Передать сообщение
`;

const snapshot = [
  { path: 'product/PRODUCT-001.yaml', content: productYaml },
  { path: 'user-story/US-001.yaml', content: storyYaml },
  { path: 'functional-requirement/FR-001.yaml', content: frYaml },
  { path: 'non-functional-requirement/NFR-001.yaml', content: nfrYaml },
  { path: 'business-object/BO-001.yaml', content: boYaml },
  { path: 'business-process/BP-001.yaml', content: bpYaml },
];

/** Сверяет машинный код и путь файла ошибки независимо от других находок. */
function expectIssue(result, code, file) {
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.code === code && issue.file === file),
    JSON.stringify(result.issues));
}

test('корректный снимок возвращает продукт и все документы', () => {
  const result = checkProductSnapshot(snapshot);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.product.id, 'PRODUCT-001');
  assert.deepEqual(result.value.documents.map(document => document.id),
    ['BO-001', 'BP-001', 'FR-001', 'NFR-001', 'PRODUCT-001', 'US-001']);
});

test('порядок файлов не влияет на результат', () => {
  const shuffled = [...snapshot].reverse();
  const result = checkProductSnapshot(shuffled);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result, checkProductSnapshot(snapshot));
});

test('отсутствие продукта и дублирование продуктов обнаруживаются', () => {
  expectIssue(checkProductSnapshot([]), 'missing_product', undefined);
  expectIssue(checkProductSnapshot(snapshot.slice(1)), 'missing_product', undefined);
  expectIssue(checkProductSnapshot([
    ...snapshot,
    { path: 'product/PRODUCT-002.yaml', content: productYaml.replace('PRODUCT-001', 'PRODUCT-002') },
  ]), 'multiple_products', 'product/PRODUCT-002.yaml');
});

/** Заменяет один файл снимка и возвращает новый набор файлов. */
function withFile(path, content) {
  return snapshot.map(file => file.path === path ? { path, content } : file);
}

test('висячие ссылки дают ошибку с файлом источника', () => {
  const brokenStory = storyYaml.replace('PRODUCT-001', 'PRODUCT-999');
  expectIssue(checkProductSnapshot(withFile('user-story/US-001.yaml', brokenStory)),
    'missing_reference', 'user-story/US-001.yaml');
  const brokenFr = frYaml.replace('story_refs: [US-001]', 'story_refs: [US-999]');
  expectIssue(checkProductSnapshot(withFile('functional-requirement/FR-001.yaml', brokenFr)),
    'missing_reference', 'functional-requirement/FR-001.yaml');
  const brokenBp = bpYaml.replace('requirement_refs: [FR-001]', 'requirement_refs: [FR-999]');
  expectIssue(checkProductSnapshot(withFile('business-process/BP-001.yaml', brokenBp)),
    'missing_reference', 'business-process/BP-001.yaml');
});

test('ссылки на документы неверного типа дают ошибку', () => {
  expectIssue(checkProductSnapshot(withFile('functional-requirement/FR-001.yaml',
    frYaml.replace('story_refs: [US-001]', 'story_refs: [NFR-001]'))),
    'wrong_reference_type', 'functional-requirement/FR-001.yaml');
  expectIssue(checkProductSnapshot(withFile('functional-requirement/FR-001.yaml',
    frYaml.replace('constraint_refs: [NFR-001]', 'constraint_refs: [US-001]'))),
    'wrong_reference_type', 'functional-requirement/FR-001.yaml');
  expectIssue(checkProductSnapshot(withFile('business-object/BO-001.yaml',
    boYaml.replace('PRODUCT-001', 'US-001'))),
    'wrong_reference_type', 'business-object/BO-001.yaml');
  const storyProductRefUs = storyYaml.replace('PRODUCT-001', 'US-001');
  expectIssue(checkProductSnapshot(withFile('user-story/US-001.yaml', storyProductRefUs)),
    'wrong_reference_type', 'user-story/US-001.yaml');
});

test('повтор идентификатора в разных файлах обнаруживается', () => {
  const duplicate = { path: 'functional-requirement/US-001.yaml', content: frYaml.replace('id: FR-001', 'id: US-001') };
  expectIssue(checkProductSnapshot([...snapshot, duplicate]),
    'duplicate_id', 'user-story/US-001.yaml');
});

test('пути, не соответствующие размещению, отклоняются', () => {
  expectIssue(checkProductSnapshot([snapshot[0], { path: 'user-story/OTHER.yaml', content: storyYaml }]),
    'invalid_layout', 'user-story/OTHER.yaml');
  expectIssue(checkProductSnapshot([snapshot[0], { path: 'product/US-001.yaml', content: storyYaml }]),
    'invalid_layout', 'product/US-001.yaml');
  expectIssue(checkProductSnapshot([snapshot[0], { path: 'bogus/X-001.yaml', content: storyYaml }]),
    'invalid_layout', 'bogus/X-001.yaml');
  expectIssue(checkProductSnapshot([snapshot[0], { path: 'user-story/US-001.md', content: storyYaml }]),
    'invalid_layout', 'user-story/US-001.md');
  expectIssue(checkProductSnapshot([snapshot[0], { path: 'a/b/US-001.yaml', content: storyYaml }]),
    'invalid_layout', 'a/b/US-001.yaml');
  expectIssue(checkProductSnapshot([snapshot[0], { path: '../user-story/US-001.yaml', content: storyYaml }]),
    'invalid_layout', '../user-story/US-001.yaml');
});

test('пути, различающиеся только регистром, конфликтуют', () => {
  expectIssue(checkProductSnapshot([
    snapshot[0],
    { path: 'user-story/us-001.yaml', content: storyYaml },
    { path: 'user-story/US-001.yaml', content: storyYaml },
  ]), 'path_conflict', 'user-story/us-001.yaml');
});

test('ошибки формы документа снабжаются путём файла и полем', () => {
  const broken = { path: 'product/PRODUCT-001.yaml', content: 'id: PRODUCT-001\ntype: product\nname: 42\npurpose: x\nboundary: y\n' };
  const result = checkProductSnapshot([broken]);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue =>
    issue.code === 'invalid_type' && issue.file === 'product/PRODUCT-001.yaml' && issue.path === '$.name'),
    JSON.stringify(result.issues));
});

test('неоднозначный YAML отклоняется с кодом invalid_yaml', () => {
  expectIssue(checkProductSnapshot([snapshot[0], { path: 'user-story/US-001.yaml', content: 'id: US-001\nid: US-002\n' }]),
    'invalid_yaml', 'user-story/US-001.yaml');
  expectIssue(checkProductSnapshot([snapshot[0], { path: 'user-story/US-001.yaml', content: 'id: US-001\n---\nid: US-002\n' }]),
    'invalid_yaml', 'user-story/US-001.yaml');
  expectIssue(checkProductSnapshot([snapshot[0], { path: 'user-story/US-001.yaml', content: 'a: &x 1\nb: *x\n' }]),
    'invalid_yaml', 'user-story/US-001.yaml');
  expectIssue(checkProductSnapshot([snapshot[0], { path: 'user-story/US-001.yaml', content: 'a: &m {x: 1}\nb:\n  <<: *m\n' }]),
    'invalid_yaml', 'user-story/US-001.yaml');
  expectIssue(checkProductSnapshot([snapshot[0], { path: 'user-story/US-001.yaml', content: 'id: !foo US-001\n' }]),
    'invalid_yaml', 'user-story/US-001.yaml');
});

test('строгий разбор возвращает данные и отклоняет расширенный синтаксис', () => {
  assert.deepEqual(parseStrictYaml('id: US-001\nname: Получение\n', 'a.yaml'), { id: 'US-001', name: 'Получение' });
  assert.deepEqual(parseStrictYaml('name: !!str Сервис\n', 'a.yaml'), { name: 'Сервис' });
  assert.equal(parseStrictYaml('', 'a.yaml'), null);
  const cases = [
    ['id: US-001\nid: US-002\n', /Повторяющийся ключ/],
    ['id: US-001\n---\nid: US-002\n', /ровно один документ/],
    ['a: &x 1\nb: *x\n', /Якоря/],
    ['a: &m {x: 1}\nb:\n  <<: *m\n', /Якоря/],
    ['a:\n  <<: 1\n', /слияния/],
    ['a: !foo 1\n', /Тег YAML/],
    ['a: !!binary aGk=\n', /Тег YAML/],
  ];
  for (const [text, expected] of cases) {
    assert.throws(() => parseStrictYaml(text, 'a.yaml'), error => {
      assert.ok(error instanceof StrictYamlError, String(error));
      assert.equal(error.source, 'a.yaml');
      assert.match(error.message, expected);
      return true;
    });
  }
});
