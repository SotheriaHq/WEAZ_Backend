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
    const constraints = error.constraints
      ? Object.values(error.constraints)
      : [];

    if (constraints.length > 0) {
      result.push({
        property: propertyPath,
        constraints,
        messages: constraints,
      });
    }

    if (Array.isArray(error.children) && error.children.length > 0) {
      result.push(...formatValidationErrors(error.children, propertyPath));
    }
  }

  return result;
}

export function formatPrimaryValidationMessage(
  errors: SafeValidationError[],
): string {
  if (!Array.isArray(errors) || errors.length === 0) {
    return 'Please check your information and try again.';
  }

  const first = errors[0];
  const prop = (first.property || '').toLowerCase();
  const rawMsg = (first.messages?.[0] || first.constraints?.[0] || '').trim();

  if (prop === 'email' || prop.endsWith('.email')) {
    return 'Please enter a valid email address (e.g. name@example.com).';
  }

  if (prop === 'password' || prop.endsWith('.password')) {
    const lower = rawMsg.toLowerCase();
    if (
      lower.includes('short') ||
      lower.includes('least') ||
      lower.includes('longer') ||
      lower.includes('character') ||
      lower.includes('12')
    ) {
      return 'Password must be at least 12 characters.';
    }
    return 'Please enter a valid password.';
  }

  if (prop === 'phone' || prop === 'phonenumber' || prop.endsWith('.phonenumber')) {
    return 'Please enter a valid phone number.';
  }

  if (rawMsg) {
    // Clean up class-validator syntax like "must be an email" or "should not be empty"
    let clean = rawMsg;
    if (clean.startsWith(first.property + ' ')) {
      clean = clean.slice(first.property.length + 1);
    }
    // Capitalize first letter
    const formatted = clean.charAt(0).toUpperCase() + clean.slice(1);
    return formatted.endsWith('.') ? formatted : `${formatted}.`;
  }

  return 'Please check your information and try again.';
}
