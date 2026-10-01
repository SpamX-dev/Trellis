/** Публичная точка входа общих типов и проверок Framework. */
export type { TaskInput, TaskResult, TaskStatus } from './agent.js';
export type { ValidationCode, ValidationIssue, ParseResult } from './validation.js';
export { parseTaskInput, parseTaskResult } from './validation.js';
