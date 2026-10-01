/** Публичная точка входа модели продуктовых документов и агента. */
export type {
  DocumentSource,
  Product,
  UserStory,
  FunctionalRequirement,
  NonFunctionalRequirementKind,
  NonFunctionalRequirement,
  ProductDocument,
} from './model.js';
export { parseProductDocument } from './validation.js';
