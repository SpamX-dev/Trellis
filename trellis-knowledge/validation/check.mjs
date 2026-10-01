/**
 * Детерминированная проверка контрактов и учебных снимков Trellis.
 * Код принадлежит Knowledge: разбирает YAML, проверяет схемы и ссылки,
 * строит временную проекцию и накладывает ChangeSet только в памяти.
 * Не исполняет AI-критерии, не пишет принятые файлы и не публикует ревизии.
 */
import { readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parseDocument, stringify, visit, isAlias, isMap, isScalar } from 'yaml';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'https://trellis.local/framework/';
const DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** Возвращает файлы внутри дерева, исключая служебные каталоги и symlink. */
function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => !['.git', 'node_modules'].includes(entry.name) && !entry.isSymbolicLink())
    .flatMap(entry => entry.isDirectory()
      ? filesUnder(resolve(directory, entry.name))
      : [resolve(directory, entry.name)]);
}

/** Формирует машинно читаемую ошибку без решения о содержательной корректности. */
function issue(code, file, pointer, message) {
  return { code, file, pointer, message };
}

/** Прерывает загрузку противоречивого контракта с указанием причины. */
function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

/** Разбирает JSON-совместимый профиль YAML; не допускает скрытых merge и aliases. */
export function parseYaml(source, file = '<memory>', document = false) {
  const parsed = parseDocument(source, { version: '1.2', uniqueKeys: true, strict: true });
  requireThat(parsed.errors.length === 0, file + ': yaml-invalid: ' + parsed.errors.map(e => e.message).join('; '));
  requireThat(parsed.warnings.length === 0, file + ': yaml-invalid: ' + parsed.warnings.map(e => e.message).join('; '));
  requireThat(parsed.directives.yaml.version === '1.2', file + ': требуется YAML 1.2');
  visit(parsed, (_key, node) => {
    requireThat(!isAlias(node) && !node?.anchor && !node?.tag, file + ': anchors, aliases и явные теги запрещены');
    if (isScalar(node) && typeof node.value === 'number') {
      requireThat(Number.isFinite(node.value), file + ': число должно быть конечным');
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        requireThat(isScalar(pair.key) && typeof pair.key.value === 'string' && pair.key.value !== '<<',
          file + ': требуется строковый ключ без merge');
      }
    }
  });
  const data = parsed.toJS({ maxAliasCount: 0 });
  if (document) {
    const firstLine = source.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0];
    requireThat(firstLine === 'id: ' + JSON.stringify(data?.id) && typeof data.id === 'string',
      file + ': первая строка должна иметь вид id: "идентификатор"');
  }
  return data;
}

/** Читает локальный YAML; ошибки разбора не превращаются в пустой документ. */
function readYaml(file, document = false) {
  return parseYaml(readFileSync(file, 'utf8'), file, document);
}

/** Разрешает файловую ссылку конфигурации только внутри выбранного Framework. */
function configPath(framework, from, target) {
  requireThat(typeof target === 'string' && !target.includes('\\') && !isAbsolute(target) &&
    !/^[a-z][a-z0-9+.-]*:/i.test(target),
    'Недопустимая ссылка конфигурации: ' + target);
  const file = realpathSync(resolve(dirname(from), target.split('#')[0]));
  const rel = relative(realpathSync(framework), file);
  requireThat(rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), 'Ссылка выходит за Framework: ' + target);
  return file;
}

/** Обходит определения схем и проверяет метаданные, не анализируя текст описаний. */
function visitObjects(value, callback) {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) callback(value);
  for (const child of Object.values(value)) visitObjects(child, callback);
}

/** Проверяет экземпляр стандартной схемой и возвращает ошибки с JSON Pointer. */
function schemaIssues(validator, data, file) {
  if (validator(data)) return [];
  return validator.errors.map(error => issue('schema-invalid', file, error.instancePath, error.message));
}

/** Загружает и компилирует локальные схемы, проверяя связь домен–агент–рендер. */
export function loadFramework(root = ROOT) {
  const framework = resolve(root, 'trellis-framework');
  const schemas = new Map();
  const schemaFiles = filesUnder(framework).filter(file => file.endsWith('.schema.yaml') || file.endsWith(sep + 'schema.yaml'));
  for (const file of schemaFiles) {
    const data = readYaml(file);
    const expectedId = ORIGIN + relative(framework, file).split(sep).join('/');
    requireThat(data.$schema === DIALECT && data.$id === expectedId, file + ': неверные $schema или $id');
    requireThat(!schemas.has(data.$id), file + ': повтор $id');
    schemas.set(data.$id, data);
  }
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const annotations = schemas.get(ORIGIN + 'contracts/annotations.schema.yaml').$defs;
  ajv.addKeyword({ keyword: 'x-trellis-ref', schemaType: 'object', metaSchema: annotations.reference, valid: true });
  ajv.addKeyword({ keyword: 'x-trellis-checks', schemaType: 'array', metaSchema: annotations.checks, valid: true });
  for (const [id, data] of schemas) ajv.addSchema(data, id);
  for (const id of schemas.keys()) requireThat(ajv.getSchema(id), 'Не удалось скомпилировать ' + id);
  const validate = name => ajv.getSchema(ORIGIN + 'contracts/' + name + '.schema.yaml');
  const manifestFile = resolve(framework, 'domains.yaml');
  const manifest = readYaml(manifestFile);
  requireThat(schemaIssues(validate('domains'), manifest, manifestFile).length === 0,
    'Конфигурация доменов не соответствует схеме: ' + JSON.stringify(validate('domains').errors));
  const types = new Map();
  const profiles = new Map();
  for (const [domain, config] of Object.entries(manifest.domains)) {
    const schemaFile = configPath(framework, manifestFile, config.schema);
    const domainSchema = readYaml(schemaFile);
    requireThat(schemas.has(domainSchema.$id), domain + ': схема не зарегистрирована');
    const definitions = domainSchema.$defs
      ? Object.entries(domainSchema.$defs).map(([type, schema]) => ({ type, schema, base: domainSchema.$id,
        id: domainSchema.$id + '#/$defs/' + type }))
      : (domainSchema.oneOf ?? []).map(branch => {
        requireThat(Object.keys(branch).length === 1 && typeof branch.$ref === 'string',
          domain + ': oneOf должен содержать только ссылки на схемы типов');
        const target = schemaTarget({ schemas }, branch.$ref, domainSchema.$id);
        const type = target.schema.properties?.type?.const;
        requireThat(target.id === target.base && target.id === domainSchema.$id.replace(/schema\.yaml$/, type + '.schema.yaml'),
          domain + ': схема типа должна находиться рядом с составом домена: ' + target.id);
        return { type, schema: target.schema, base: target.base, id: target.id };
      });
    if (domainSchema.$defs) {
      const expectedBranches = definitions.map(({ type }) => '#/$defs/' + type).sort();
      requireThat(JSON.stringify(domainSchema.oneOf?.map(branch => branch.$ref).sort()) === JSON.stringify(expectedBranches),
        domain + ': oneOf должен перечислять все и только собственные типы');
    } else {
      const siblings = filesUnder(dirname(schemaFile)).filter(file => file.endsWith('.schema.yaml') && file !== schemaFile)
        .map(file => ORIGIN + relative(framework, file).split(sep).join('/')).sort();
      requireThat(JSON.stringify(definitions.map(({ id }) => id).sort()) === JSON.stringify(siblings),
        domain + ': состав домена должен перечислять все схемы типов из каталога');
    }
    for (const { type, schema: definition, base, id } of definitions) {
      requireThat(!types.has(type), 'Повтор имени типа: ' + type);
      requireThat(definition.properties?.type?.const === type, 'Неоднозначный type: ' + type);
      const validator = ajv.getSchema(id);
      types.set(type, { domain, schema: definition, base, validator });
    }
    profiles.set(domain, { config, schemaFile, schema: domainSchema });
  }
  const checkIds = new Set();
  for (const [id, data] of schemas) visitObjects(data, node => {
    if (node['x-trellis-ref']) {
      requireThat(node.type === 'string' || node.$ref?.endsWith('common.schema.yaml#/$defs/id'),
        id + ': x-trellis-ref допускается только на строке-ссылке');
      for (const target of node['x-trellis-ref'].targets) requireThat(types.has(target), id + ': неизвестная цель ' + target);
    }
    for (const check of node['x-trellis-checks'] ?? []) {
      requireThat(!checkIds.has(check.id), 'Повтор критерия: ' + check.id);
      checkIds.add(check.id);
    }
  });
  const state = { root, framework, schemas, ajv, manifest, types, profiles, validate };
  for (const [domain, { config, schema }] of profiles) {
    for (const source of config.on_change ?? []) {
      requireThat(profiles.has(source) && source !== domain, domain + ': некорректная подписка ' + source);
    }
    const agentFile = configPath(framework, manifestFile, config.agent);
    const agent = readYaml(agentFile);
    if (agent.format_version === '1') {
      validateAgentPackageDefinition(state, agent, agentFile);
    } else {
      requireThat(schemaIssues(validate('agent'), agent, agentFile).length === 0 && agent.domain === domain,
        domain + ': неверный контракт агента');
      const skillNames = new Set();
      for (const skill of agent.skills) {
        requireThat(!skillNames.has(skill.name), domain + ': повтор навыка ' + skill.name);
        skillNames.add(skill.name);
        const targetFile = configPath(framework, agentFile, skill.schema);
        requireThat(readYaml(targetFile).$id === schema.$id, skill.name + ': схема результата относится к другому домену');
        const target = new URL(skill.schema, ORIGIN + relative(framework, agentFile).split(sep).join('/')).href;
        const resultValidator = ajv.getSchema(target);
        requireThat(resultValidator, skill.name + ': неизвестная схема ' + target);
        for (const example of skill.examples ?? []) {
          const exampleFile = configPath(framework, agentFile, example);
          const value = readYaml(exampleFile, true);
          requireThat(resultValidator(value), skill.name + ': пример не соответствует схеме результата');
        }
      }
    }
    if (config.render) {
      const renderFile = configPath(framework, manifestFile, config.render);
      const render = readYaml(renderFile);
      requireThat(schemaIssues(validate('render'), render, renderFile).length === 0 && render.domain === domain,
        domain + ': неверный контракт рендера');
      const domainTypes = [...types].filter(([_type, profile]) => profile.domain === domain).map(([type]) => type).sort();
      requireThat(JSON.stringify(Object.keys(render.types).sort()) === JSON.stringify(domainTypes),
        domain + ': рендер должен перечислять типы домена');
      for (const [type, view] of Object.entries(render.types)) {
        const fields = new Set();
        for (const field of view.fields) {
          requireThat(field.field in types.get(type).schema.properties && !fields.has(field.field),
            type + ': неверное или повторное поле рендера ' + field.field);
          fields.add(field.field);
        }
      }
    }
  }
  return state;
}

/**
 * Разрешает ссылку на зарегистрированную схему в фиксированном снимке Framework.
 * Поддерживает только локальные URI и JSON Pointer; содержимое вне набора схем и
 * сетевые загрузки не могут изменить проверку или текст, передаваемый агенту.
 */
function schemaTarget(framework, reference, base) {
  const url = new URL(reference, base);
  const schemaId = url.origin + url.pathname;
  requireThat(schemaId.startsWith(ORIGIN) && !url.search, 'Ссылка на схему выходит за Framework: ' + url.href);
  const root = framework.schemas.get(schemaId);
  requireThat(root, 'Незарегистрированная схема: ' + url.href);
  let target = root;
  if (url.hash && url.hash !== '#') {
    const pointer = decodeURIComponent(url.hash.slice(1));
    requireThat(pointer.startsWith('/') && !/~(?![01])/.test(pointer), 'Ожидается JSON Pointer: ' + url.href);
    for (const segment of pointer.slice(1).split('/')) {
      target = target?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
  }
  requireThat(target && typeof target === 'object', 'Неизвестное определение: ' + url.href);
  return { id: url.href, schema: target, base: schemaId };
}

/**
 * Превращает относительный путь автора в URI схемы, не позволяя выйти за Framework.
 * Проверка реального пути исключает symlink за пределы снимка; фрагмент URI затем
 * разрешается по тому же зарегистрированному объекту, что использует Ajv.
 */
function authoredSchemaTarget(framework, from, reference) {
  const file = configPath(framework.framework, from, reference);
  const schemaId = ORIGIN + relative(framework.framework, file).split(sep).join('/');
  const hash = reference.includes('#') ? reference.slice(reference.indexOf('#')) : '';
  return schemaTarget(framework, schemaId + hash, schemaId);
}

/**
 * Строит замкнутый набор фрагментов схем из входа, выхода и навыков пакета.
 * Каждый фрагмент хранится один раз по каноническому URI; текст для агента
 * сериализуется непосредственно из тех же объектов, которые зарегистрированы в Ajv.
 */
function schemaContext(framework, roots) {
  const fragments = new Map();
  function include(reference, base) {
    const target = schemaTarget(framework, reference, base);
    if (fragments.has(target.id)) return;
    fragments.set(target.id, target.schema);
    visitObjects(target.schema, node => {
      requireThat(!node.$anchor && !node.$dynamicAnchor && !node.$dynamicRef &&
        (!node.$id || node === framework.schemas.get(target.base)),
        'Контекст пакета поддерживает только локальные $ref с JSON Pointer: ' + target.id);
      if (node.$ref) include(node.$ref, target.base);
    });
  }
  for (const root of roots) include(root.id, root.base);
  const entries = [...fragments].sort(([left], [right]) => left.localeCompare(right))
    .map(([id, schema]) => ({ id, schema, text: stringify(schema).trimEnd() }));
  return { fragments: entries, text: entries.map(entry => `${entry.id}\n${entry.text}`).join('\n\n') };
}

/**
 * Проверяет определение пакета и его локальные зависимости без исполнения агента.
 * Гейты остаются декларациями: здесь проверяются их типы и ссылки, но состояние
 * задачи, Git-ветка и результат проверки Knowledge не моделируются.
 */
export function validateAgentPackageDefinition(framework, definition, agentFile) {
  const source = realpathSync(agentFile);
  const sourceRelative = relative(realpathSync(framework.framework), source);
  requireThat(sourceRelative !== '..' && !sourceRelative.startsWith('..' + sep) && !isAbsolute(sourceRelative),
    agentFile + ': источник пакета находится вне Framework');
  const validator = framework.validate('agent-package');
  const issues = schemaIssues(validator, definition, agentFile);
  requireThat(issues.length === 0, agentFile + ': неверный контракт пакета: ' + JSON.stringify(issues));
  requireThat(framework.profiles.has(definition.domain) && definition.id.startsWith(definition.domain + '.'),
    agentFile + ': имя пакета не соответствует зарегистрированному домену');
  const instructionsFile = configPath(framework.framework, agentFile, definition.instructions);
  const instructions = readFileSync(instructionsFile, 'utf8');
  requireThat(instructions.trim(), instructionsFile + ': пустая инструкция');
  const roots = [];
  const endpointValidators = {};
  for (const endpoint of ['input', 'output']) {
    const target = authoredSchemaTarget(framework, agentFile, definition[endpoint].schema);
    const compiled = framework.ajv.getSchema(target.id);
    requireThat(compiled, endpoint + ': схема не компилируется: ' + target.id);
    roots.push(target);
    endpointValidators[endpoint] = compiled;
  }
  const skillNames = new Set();
  const skills = definition.skills.map(reference => {
    const file = configPath(framework.framework, agentFile, reference);
    requireThat(file.endsWith(sep + 'skill.yaml'), file + ': ожидается отдельный каталог с skill.yaml');
    const skill = readYaml(file);
    const skillIssues = schemaIssues(framework.validate('skill'), skill, file);
    requireThat(skillIssues.length === 0, file + ': неверный контракт навыка: ' + JSON.stringify(skillIssues));
    requireThat(!skillNames.has(skill.name), file + ': повтор навыка ' + skill.name);
    skillNames.add(skill.name);
    for (const schemaRef of skill.schemas) {
      const target = authoredSchemaTarget(framework, file, schemaRef);
      requireThat(framework.ajv.getSchema(target.id), file + ': схема не компилируется: ' + target.id);
      roots.push(target);
    }
    for (const example of skill.examples ?? []) {
      requireThat(skill.schemas.includes(example.schema), file + ': схема примера не объявлена в навыке');
      const target = authoredSchemaTarget(framework, file, example.schema);
      const exampleFile = configPath(framework.framework, file, example.file);
      const exampleIssues = schemaIssues(framework.ajv.getSchema(target.id), readYaml(exampleFile), exampleFile);
      requireThat(exampleIssues.length === 0, exampleFile + ': пример не соответствует схеме: ' + JSON.stringify(exampleIssues));
    }
    return { file, ...skill };
  });
  const gateSchemas = new Map();
  const gateIds = new Set();
  for (const gate of definition.gates) {
    requireThat(!gateIds.has(gate.id), agentFile + ': повтор гейта ' + gate.id);
    gateIds.add(gate.id);
    for (const field of ['value', 'changeset', 'proposal', 'allowed']) {
      if (gate[field]) requireThat(!/~(?![01])/.test(gate[field]), agentFile + ': неверный JSON Pointer гейта ' + gate.id);
    }
    if (gate.check === 'knowledge_revision_valid') {
      const skill = skills.find(item => item.name === gate.skill);
      requireThat(skill && skill.schemas.length === 1,
        agentFile + ': гейт ' + gate.id + ' требует навык с одной схемой: ' + gate.skill);
      const target = authoredSchemaTarget(framework, skill.file, skill.schemas[0]);
      requireThat(target.base === framework.profiles.get(definition.domain).schema.$id,
        agentFile + ': схема гейта ' + gate.id + ' должна принадлежать домену результата');
      gateSchemas.set(gate.id, target);
    }
  }
  return { definition, instructions, skills, gateSchemas,
    schemaContext: schemaContext(framework, roots), validators: endpointValidators };
}

/** Читает один источник пакета и применяет к нему общий контракт и проверку ссылок. */
export function loadAgentPackage(framework, agentFile) {
  return validateAgentPackageDefinition(framework, readYaml(agentFile), agentFile);
}

/** Раскрывает локальный $ref в пределах зарегистрированных схем без сетевой загрузки. */
function dereference(schema, base, framework) {
  const seen = new Set();
  while (schema.$ref) {
    const url = new URL(schema.$ref, base);
    requireThat(!seen.has(url.href), 'Циклический $ref при обходе ссылок: ' + url.href);
    seen.add(url.href);
    const root = framework.schemas.get(url.origin + url.pathname);
    requireThat(root, 'Незарегистрированная схема: ' + url.href);
    let target = root;
    if (url.hash) {
      requireThat(url.hash.startsWith('#/'), 'Ожидается JSON Pointer: ' + url.href);
      for (const segment of url.hash.slice(2).split('/')) {
        target = target?.[decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~')];
      }
    }
    requireThat(target && typeof target === 'object', 'Неизвестное определение: ' + url.href);
    const { $ref: _ref, ...siblings } = schema;
    schema = { ...target, ...siblings };
    base = root.$id;
  }
  return { schema, base };
}

/** Извлекает только явно аннотированные ссылки вместе с их адресом в документе. */
function collectReferences(value, schema, base, framework, pointer = '') {
  ({ schema, base } = dereference(schema, base, framework));
  const result = [];
  if (schema['x-trellis-ref'] && typeof value === 'string') {
    result.push({ target: value, ...schema['x-trellis-ref'], pointer });
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => result.push(...collectReferences(item, schema.items, base, framework, pointer + '/' + index)));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        const escaped = key.replace(/~/g, '~0').replace(/\//g, '~1');
        result.push(...collectReferences(value[key], child, base, framework, pointer + '/' + escaped));
      }
    }
  }
  return result;
}

/** Проверяет переносимый относительный путь; реальная запись также требует проверки symlink. */
function safePath(path) {
  return typeof path === 'string' && !/[\\<>:"|?*\x00-\x1f]/.test(path) &&
    !isAbsolute(path) && path.split('/').every(part => part && part !== '.' && part !== '..' &&
      !/[. ]$/.test(part) && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
}

/** Проверяет весь снимок и возвращает временный граф; ничего не сохраняет на диск. */
export function validateDocuments(framework, records) {
  const issues = [];
  const index = new Map();
  const paths = new Set();
  const nodes = [];
  const edges = [];
  const valid = [];
  for (const record of records) {
    const { file, data } = record;
    const profile = framework.types.get(data?.type);
    if (!profile) {
      issues.push(issue('schema-invalid', file, '/type', 'Неизвестный тип документа'));
      continue;
    }
    const structural = schemaIssues(profile.validator, data, file);
    issues.push(...structural);
    if (structural.length) continue;
    const parts = file.split('/');
    if (!safePath(file) || parts.length < 3 || parts[0] !== profile.domain || parts[1] !== data.type || parts.at(-1) !== data.id + '.yaml') {
      issues.push(issue('layout-invalid', file, '', 'Ожидается домен/тип/[группа/]id.yaml'));
    }
    if (paths.has(file.toLowerCase())) issues.push(issue('layout-invalid', file, '', 'Повтор пути, включая различие только регистром'));
    paths.add(file.toLowerCase());
    if (index.has(data.id)) issues.push(issue('id-duplicate', file, '/id', 'Идентификатор уже объявлен в ' + index.get(data.id).file));
    index.set(data.id, record);
    valid.push({ ...record, profile });
    nodes.push({ id: data.id, type: data.type, file });
  }
  for (const { file, data, profile } of valid) {
    for (const reference of collectReferences(data, profile.schema, profile.base, framework)) {
      const target = index.get(reference.target);
      if (!target) issues.push(issue('ref-not-found', file, reference.pointer, 'Не найден документ ' + reference.target));
      else if (!reference.targets.includes(target.data.type)) issues.push(issue('ref-type-invalid', file, reference.pointer, 'Недопустимый тип цели ' + target.data.type));
      else edges.push({ from: data.id, to: reference.target, relation: reference.relation, pointer: reference.pointer });
    }
    if (data.type === 'business-process') {
      const keys = new Set();
      for (const [i, step] of data.steps.entries()) {
        if (keys.has(step.key)) issues.push(issue('id-duplicate', file, '/steps/' + i + '/key', 'Повтор локального ключа шага'));
        keys.add(step.key);
      }
      for (const [i, step] of data.steps.entries()) {
        for (const target of step.next_steps ?? []) {
          if (!keys.has(target)) issues.push(issue('ref-not-found', file, '/steps/' + i + '/next_steps', 'Не найден локальный шаг ' + target));
        }
      }
    }
  }
  return { issues, graph: { nodes, edges } };
}

/** Читает один полный пример; поиск id при проверке использует только временную память. */
export function readExample(framework) {
  const directory = resolve(framework.framework, 'examples/notification-service/documents');
  return filesUnder(directory).filter(file => file.endsWith('.yaml')).map(file => ({
    file: relative(directory, file).split(sep).join('/'),
    data: readYaml(file, true),
  }));
}

/** Проверяет операции на базовом снимке, затем валидирует весь предложенный результат. */
export function validateChangeSet(framework, records, change, revision, frameworkRevision) {
  const issues = schemaIssues(framework.validate('changeset'), change, 'changeset');
  if (issues.length) return { issues, records };
  if (change.base_revision !== revision || change.framework_revision !== frameworkRevision) {
    return { issues: [issue('revision-conflict', 'changeset', '', 'Базовая ревизия или ревизия Framework изменилась')], records };
  }
  const baseline = new Map(records.map(record => [record.file, record]));
  const affected = new Set();
  for (const [i, operation] of change.operations.entries()) {
    const pointer = '/operations/' + i;
    const original = baseline.get(operation.path);
    if (!safePath(operation.path) || affected.has(operation.path.toLowerCase())) {
      issues.push(issue('operation-invalid', operation.path, pointer, 'Небезопасный или повторный путь'));
    }
    affected.add(operation.path.toLowerCase());
    if (operation.op === 'add' ? !!original : !original || original.data.id !== operation.document_id) {
      issues.push(issue('operation-invalid', operation.path, pointer, 'Операция не соответствует исходному пути и id'));
    }
    if (operation.document && operation.document.id !== operation.document_id) {
      issues.push(issue('operation-invalid', operation.path, pointer + '/document/id', 'Идентичность документа не совпадает'));
    }
  }
  if (issues.length) return { issues, records };
  const proposed = new Map(baseline);
  for (const operation of change.operations) if (operation.op === 'remove') proposed.delete(operation.path);
  for (const operation of change.operations) {
    if (operation.op !== 'remove') proposed.set(operation.path, { file: operation.path, data: structuredClone(operation.document) });
  }
  const next = [...proposed.values()];
  return { ...validateDocuments(framework, next), records: next };
}

/**
 * Извлекает значение структурированного результата по JSON Pointer гейта.
 * Отсутствующее поле не считается успешной проверкой; текст указателя не может
 * обращаться к произвольным файлам, сервисам или свойствам прототипа.
 */
function resultPointer(value, pointer) {
  requireThat(typeof pointer === 'string' && pointer.startsWith('/') && !/~(?![01])/.test(pointer),
    'Некорректный JSON Pointer гейта: ' + pointer);
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    requireThat(value && typeof value === 'object' && Object.hasOwn(value, key),
      'Поле результата для гейта отсутствует: ' + pointer);
    value = value[key];
  }
  return value;
}

/** Проверяет локальные Markdown-ссылки, не обращаясь к сети и игнорируя примеры кода. */
function checkMarkdownLinks(root) {
  const issues = [];
  for (const file of filesUnder(root).filter(file => file.endsWith('.md'))) {
    const content = readFileSync(file, 'utf8').replace(/^\s*\x60{3}[\s\S]*?^\s*\x60{3}\s*$/gm, '');
    const pattern = /\[[^\]]+\]\((?:<([^>]+)>|([^\s)]+))\)/g;
    for (const match of content.matchAll(pattern)) {
      const target = match[1] ?? match[2];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      const location = decodeURIComponent(target.split('#')[0]);
      if (!existsSync(resolve(dirname(file), location))) issues.push(issue('link-not-found', relative(root, file), '', target));
    }
  }
  return issues;
}

/** Запускает проверку контрактов и учебных документов; выводит проверенные объёмы и явный отказ. */
export function checkRepository(root = ROOT) {
  const framework = loadFramework(root);
  const records = readExample(framework);
  const snapshot = validateDocuments(framework, records);
  const change = readYaml(resolve(framework.framework, 'examples/notification-service/changeset.yaml'));
  const proposal = validateChangeSet(framework, records, change, 'example-base', 'example-framework');
  const sources = ['domains/product/agent', 'examples/compliance-check-agent-package'];
  const packages = sources.map(name => {
    const directory = resolve(framework.framework, name);
    const source = loadAgentPackage(framework, resolve(directory, 'agent.yaml'));
    if (name.startsWith('domains/')) return { source, issues: [] };
    const input = readYaml(resolve(directory, 'input.yaml'));
    const output = readYaml(resolve(directory, 'output.yaml'));
    const issues = [
      ...schemaIssues(source.validators.input, input, name + '/input.yaml'),
      ...schemaIssues(source.validators.output, output, name + '/output.yaml'),
    ];
    for (const gate of source.definition.gates) {
      for (const field of ['value', 'changeset', 'proposal']) if (gate[field]) resultPointer(output, gate[field]);
      if (gate.allowed) resultPointer(input, gate.allowed);
    }
    return { source, input, output, issues };
  });
  const issues = [...snapshot.issues, ...proposal.issues, ...packages.flatMap(item => item.issues), ...checkMarkdownLinks(root)];
  requireThat(issues.length === 0, JSON.stringify(issues, null, 2));
  return { schemas: framework.schemas.size, domains: framework.profiles.size, types: framework.types.size,
    documents: records.length, edges: snapshot.graph.edges.length, changesets: 1, agentPackages: packages.length,
    schemaFragments: packages.reduce((count, item) => count + item.source.schemaContext.fragments.length, 0), markdownLinks: 'ok' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(checkRepository(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
