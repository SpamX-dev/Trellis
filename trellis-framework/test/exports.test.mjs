import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

test('собранный пакет предоставляет три точки входа', async () => {
  const framework = await import('@trellis/framework');
  const product = await import('@trellis/framework/product');
  const node = await import('@trellis/framework/node');
  assert.equal(typeof framework.parseTaskInput, 'function');
  assert.equal(typeof framework.parseTaskResult, 'function');
  assert.equal(typeof product.parseProductDocument, 'function');
  assert.deepEqual(Object.keys(node), []);
  for (const declaration of ['index.d.ts', 'product/index.d.ts', 'node/index.d.ts']) {
    assert.equal(existsSync(new URL(`../dist/${declaration}`, import.meta.url)), true, declaration);
  }
  const modelDeclaration = readFileSync(new URL('../dist/product/model.d.ts', import.meta.url), 'utf8');
  assert.match(modelDeclaration, /Продукт и граница его ответственности/);
  assert.match(modelDeclaration, /Точные имена групп для поиска/);
  const validationDeclaration = readFileSync(new URL('../dist/validation.d.ts', import.meta.url), 'utf8');
  assert.match(validationDeclaration, /Ошибка проверки с путём к конкретному полю/);
});
