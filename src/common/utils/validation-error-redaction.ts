import type { ValidationError } from 'class-validator';

export type SafeValidationError = {
  property: string;
  constraints: string[];
  messages: string[];
};

export function formatValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): SafeValidationError[] {
  const result: SafeValidationError[] = [];

  for (const error of errors) {
    const propertyPath = parentPath
      ? `${parentPath}.${error.property}`
      : error.property || 'unknown';
    const constraints = error.constraints ? Object.values(error.constraints) : [];

    if (constraints.length > 0) {
      result.push({ property: propertyPath, constraints, messages: constraints });
    }

    if (Array.isArray(error.children) && error.children.length > 0) {
      result.push(...formatValidationErrors(error.children, propertyPath));
    }
  }

  return result;
}
