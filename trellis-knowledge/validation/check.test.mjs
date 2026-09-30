/**
 * Проверки отказов и связности публичных контрактов Knowledge.
 * Используется учебный снимок, затем в памяти вносятся отдельные ошибки.
 * Тесты не пишут документы, не запускают агентов и не проверяют работу БД.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, parseYaml, loadFramework, readExample, validateDocuments, validateChangeSet } from './check.mjs';

const framework = loadFramework();
const baseline = readExample(framework);

/** Возвращает независимую копию исходного снимка для одного сценария. */
function snapshot() {
  return structuredClone(baseline);
}

/** Выбирает документ из тестового снимка по публичному идентификатору. */
function document(records, id) {
  return records.find(record => record.data.id === id).data;
}

/** Собирает предложение на известной базе, не добавляя решения человека. */
function proposal(operations) {
  return { id: 'TEST-CHANGE', base_revision: 'example-base', framework_revision: 'example-framework',
    reason: 'Проверка контракта', operations };
}

/** Проверяет предложение тем же путём, что и учебный сценарий. */
function checkChange(change) {
  return validateChangeSet(framework, baseline, change, 'example-base', 'example-framework');
}

test('согласованный пример строит ссылки из полей, включая вложенные шаги', () => {
  const result = validateDocuments(framework, baseline);
  assert.deepEqual(result.issues, []);
  assert.ok(result.graph.edges.some(edge => edge.from === 'BP-001' &&
    edge.to === 'ACTOR-001' && edge.pointer === '/steps/0/actor_ref'));
  assert.ok(result.graph.edges.some(edge => edge.from === 'CHECK-001' && edge.to === 'COMP-001'));
});

test('поисковый профиль сохраняет строковый id с ведущими нулями', () => {
  assert.equal(parseYaml('id: "001"\ntype: product\n', 'sample', true).id, '001');
  assert.throws(() => parseYaml('id: 001\ntype: product\n', 'sample', true), /первая строка/);
});

test('неоднозначный и выходящий за YAML-профиль ввод отклоняется', () => {
  for (const source of [
    'name: one\nname: two\n',
    'name: &shared value\nother: *shared\n',
    'name: !!str value\n',
    'name: one\n---\nname: two\n',
    'number: .inf\n',
    '1: value\n',
    '<<: {name: merged}\n',
  ]) assert.throws(() => parseYaml(source));
});

test('дубли id выявляются даже при разных путях файлов', () => {
  const records = snapshot();
  const repeated = structuredClone(records.find(record => record.data.id === 'FR-001'));
  repeated.file = 'product/functional-requirement/other/FR-001.yaml';
  records.push(repeated);
  assert.ok(validateDocuments(framework, records).issues.some(error => error.code === 'id-duplicate'));
});

test('ссылка на отсутствующую роль не становится допустимым ребром', () => {
  const records = snapshot();
  document(records, 'US-001').actor_ref = 'ACTOR-MISSING';
  const result = validateDocuments(framework, records);
  assert.ok(result.issues.some(error => error.code === 'ref-not-found' && error.pointer === '/actor_ref'));
  assert.ok(!result.graph.edges.some(edge => edge.to === 'ACTOR-MISSING'));
});

test('существующий документ неподходящего типа не разрешает ссылку', () => {
  const records = snapshot();
  document(records, 'US-001').actor_ref = 'FR-001';
  assert.ok(validateDocuments(framework, records).issues.some(error => error.code === 'ref-type-invalid'));
});

test('локальный переход процесса проверяется внутри его шагов', () => {
  const records = snapshot();
  document(records, 'BP-001').steps[0].next_steps = ['missing-step'];
  assert.ok(validateDocuments(framework, records).issues.some(error =>
    error.code === 'ref-not-found' && error.pointer === '/steps/0/next_steps'));
});

test('условное обязательство требует условия и назначенной процедуры', () => {
  for (const field of ['trigger', 'procedure_refs']) {
    const records = snapshot();
    delete document(records, 'COMP-001')[field];
    assert.ok(validateDocuments(framework, records).issues.some(error => error.code === 'schema-invalid'));
  }
});

test('оценка не совмещает неизвестную применимость с доказанным выполнением', () => {
  const records = snapshot();
  Object.assign(document(records, 'CHECK-001'), { applicability: 'unknown', conformance: 'satisfied' });
  assert.ok(validateDocuments(framework, records).issues.some(error => error.code === 'schema-invalid'));
});

test('положительная оценка требует материалов, а unknown — явных пробелов применимости', () => {
  const records = snapshot();
  document(records, 'CHECK-001').conformance = 'satisfied';
  assert.ok(validateDocuments(framework, records).issues.some(error => error.code === 'schema-invalid'));
  document(records, 'CHECK-001').applicability = 'unknown';
  document(records, 'CHECK-001').conformance = 'unknown';
  delete document(records, 'CHECK-001').gaps;
  assert.ok(validateDocuments(framework, records).issues.some(error => error.code === 'schema-invalid'));
});

test('опечатка в пользовательской аннотации отклоняется строгой компиляцией', () => {
  const schema = structuredClone(framework.profiles.get('product').schema);
  schema.$id = 'https://trellis.local/framework/domains/product/invalid.schema.yaml';
  schema.$defs.product.properties.purpose['x-trellis-typo'] = true;
  assert.throws(() => framework.ajv.compile(schema), /unknown keyword/);
});

test('связанные новые документы проверяются совместно независимо от порядка операций', () => {
  const actor = structuredClone(document(baseline, 'ACTOR-001'));
  actor.id = 'ACTOR-002';
  const story = structuredClone(document(baseline, 'US-001'));
  Object.assign(story, { id: 'US-002', actor_ref: actor.id });
  const change = proposal([
    { op: 'add', path: 'product/user-story/US-002.yaml', document_id: story.id, document: story },
    { op: 'add', path: 'product/actor/ACTOR-002.yaml', document_id: actor.id, document: actor },
  ]);
  const before = snapshot();
  const result = checkChange(change);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(baseline, before);
  assert.ok(result.graph.edges.some(edge => edge.from === story.id && edge.to === actor.id));
});

test('удаление используемого документа отклоняется по итоговому снимку', () => {
  const result = checkChange(proposal([
    { op: 'remove', path: 'product/actor/ACTOR-001.yaml', document_id: 'ACTOR-001' },
  ]));
  assert.ok(result.issues.some(error => error.code === 'ref-not-found'));
});

test('перемещение в тематический каталог сохраняет идентичность и ссылки', () => {
  const data = structuredClone(document(baseline, 'FR-001'));
  const result = checkChange(proposal([
    { op: 'remove', path: 'product/functional-requirement/FR-001.yaml', document_id: data.id },
    { op: 'add', path: 'product/functional-requirement/email/FR-001.yaml', document_id: data.id, document: data },
  ]));
  assert.deepEqual(result.issues, []);
  assert.equal(result.records.filter(record => record.data.id === data.id).length, 1);
});

test('конфликт снимка документов или Framework требует нового предложения', () => {
  const change = parseYaml(readFileSync(resolve(ROOT, 'trellis-framework/examples/notification-service/changeset.yaml'), 'utf8'));
  for (const field of ['base_revision', 'framework_revision']) {
    const changed = structuredClone(change);
    changed[field] = 'different-revision';
    assert.equal(checkChange(changed).issues[0].code, 'revision-conflict');
  }
});

test('выход пути за базу и повтор операции не допускаются', () => {
  const data = structuredClone(document(baseline, 'FR-001'));
  for (const path of ['../FR-001.yaml', 'C:/FR-001.yaml', 'product/../FR-001.yaml',
    'product/functional-requirement/CON/FR-001.yaml', 'product/functional-requirement/group?/FR-001.yaml']) {
    assert.ok(checkChange(proposal([{ op: 'add', path, document_id: data.id, document: data }]))
      .issues.some(error => error.code === 'operation-invalid'));
  }
  const remove = { op: 'remove', path: 'product/functional-requirement/FR-001.yaml', document_id: data.id };
  assert.ok(checkChange(proposal([remove, remove])).issues.some(error => error.code === 'operation-invalid'));
});

test('пример изменения не мутирует исходные документы', () => {
  const change = parseYaml(readFileSync(resolve(ROOT, 'trellis-framework/examples/notification-service/changeset.yaml'), 'utf8'));
  const result = checkChange(change);
  assert.deepEqual(result.issues, []);
  assert.equal(document(result.records, 'NFR-001').target, 'Не более 3 секунд для 95% запросов.');
  assert.equal(document(baseline, 'NFR-001').target, 'Не более 5 секунд для 95% запросов.');
});
