/** Публичная точка входа модели продуктовых документов, проверок и агента. */
export type {
  DocumentSource,
  Product,
  UserStory,
  FunctionalRequirement,
  NonFunctionalRequirementKind,
  NonFunctionalRequirement,
  BusinessAttributeValueType,
  BusinessAttribute,
  BusinessObject,
  BusinessProcessStep,
  BusinessProcess,
  ProductDocument,
} from './model.js';
export { parseProductDocument } from './validation.js';
export type {
  SnapshotFile,
  SnapshotCode,
  SnapshotIssue,
  CheckedProductSnapshot,
  SnapshotCheckResult,
} from './snapshot.js';
export { checkProductSnapshot } from './snapshot.js';
