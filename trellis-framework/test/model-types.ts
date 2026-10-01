import type {
  BusinessAttributeValueType,
  BusinessObject,
  BusinessProcess,
  BusinessProcessStep,
  FunctionalRequirement,
  NonFunctionalRequirement,
  Product,
  ProductDocument,
  SnapshotFile,
  UserStory,
} from '../src/product/index.js';

/**
 * Корректные экземпляры для построения отрицательных вариантов.
 * Данные учебного продукта хранятся в YAML, а эти объекты нужны только
 * для проверки типов модели компилятором.
 */
const product: Product = {
  id: 'PRODUCT-001',
  type: 'product',
  name: 'Сервис уведомлений',
  purpose: 'Доставлять уведомления.',
  boundary: 'Отправка сообщений.',
};

const userStory: UserStory = {
  id: 'US-001',
  type: 'user-story',
  name: 'Получение сообщения',
  product_ref: product.id,
  actor: 'Пользователь',
  goal: 'Получить сообщение.',
  benefit: 'Быть в курсе.',
};

const functionalRequirement: FunctionalRequirement = {
  id: 'FR-001',
  type: 'functional-requirement',
  name: 'Подтверждение адреса',
  product_ref: product.id,
  statement: 'Включить уведомления после подтверждения.',
  acceptance_criteria: ['Без подтверждения уведомления не отправляются.'],
};

const nonFunctionalRequirement: NonFunctionalRequirement = {
  id: 'NFR-001',
  type: 'non-functional-requirement',
  name: 'Время отправки',
  product_ref: product.id,
  kind: 'performance',
  statement: 'Быстрая отправка.',
  measure: 'Время до передачи.',
  target: 'Не более 5 секунд.',
  context: 'При штатной нагрузке.',
};

/** Компилятор должен отклонять число вместо обязательного текста. */
export const invalidPurpose: Product = {
  ...product,
  // @ts-expect-error Назначение продукта является строкой.
  purpose: 42,
};

/** Компилятор должен отклонять старую ссылку на отдельный документ роли. */
export const invalidActorReference: UserStory = {
  ...userStory,
  // @ts-expect-error Роль задана полем actor, а actor_ref отсутствует в модели.
  actor_ref: 'ACTOR-001',
};

/** Компилятор должен отклонять строку вместо списка критериев. */
export const invalidAcceptanceCriteria: FunctionalRequirement = {
  ...functionalRequirement,
  // @ts-expect-error Критерии приёмки являются списком строк.
  acceptance_criteria: 'Подтверждение выполнено',
};

/** Компилятор должен отклонять категорию вне закрытого набора. */
export const invalidKind: NonFunctionalRequirement = {
  ...nonFunctionalRequirement,
  // @ts-expect-error Категория latency не входит в модель NFR.
  kind: 'latency',
};

/** Компилятор должен отклонять неизвестный тип документа. */
export const invalidDocumentType: ProductDocument = {
  ...product,
  // @ts-expect-error Первый цикл поддерживает только шесть типов документов.
  type: 'stakeholder',
};

const businessObject: BusinessObject = {
  id: 'BO-001',
  type: 'business-object',
  name: 'Уведомление',
  product_ref: product.id,
  definition: 'Сообщение, доставляемое получателю.',
  attributes: [
    { name: 'канал', meaning: 'Способ доставки.', value_type: 'string' },
  ],
};

/** Компилятор должен отклонять вид значения вне закрытого набора. */
// @ts-expect-error Вид uuid не входит в набор предметных видов значений.
export const invalidAttributeValueType: BusinessAttributeValueType = 'uuid';

const businessProcessStep: BusinessProcessStep = {
  key: 'send',
  name: 'Передать сообщение',
  actor: 'Сервис уведомлений',
  requirement_refs: [functionalRequirement.id],
};

const businessProcess: BusinessProcess = {
  id: 'BP-001',
  type: 'business-process',
  name: 'Доставка уведомления',
  product_ref: product.id,
  goal: 'Доставить уведомление.',
  steps: [
    { key: 'confirm', name: 'Подтвердить адрес', next_steps: [businessProcessStep.key] },
    businessProcessStep,
  ],
};

/** Компилятор должен отклонять процесс без обязательного списка шагов. */
export const invalidProcessSteps: BusinessProcess = {
  ...businessProcess,
  // @ts-expect-error Шаги процесса обязательны.
  steps: undefined,
};

/** Компилятор должен принимать файл снимка с путём и текстовым содержимым. */
export const snapshotFile: SnapshotFile = {
  path: 'user-story/US-001.yaml',
  content: 'id: US-001\n',
};

/** Компилятор должен отклонять файл снимка без текстового содержимого. */
export const invalidSnapshotContent: SnapshotFile = {
  path: 'user-story/US-001.yaml',
  // @ts-expect-error Содержимое файла снимка является строкой.
  content: 42,
};
