export const EMPLOYEE_DIRECTORY_ROLES = ["admin", "user"] as const;

export type EmployeeDirectoryRole = (typeof EMPLOYEE_DIRECTORY_ROLES)[number];

const EMPLOYEE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMPLOYEE_EMAIL_LENGTH = 320;

/**
 * The directory owns the canonical employee email, so every caller must use
 * this form before querying or writing an employee record.
 */
export function normalizeEmployeeEmail(value: string) {
  const normalized = value.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > MAX_EMPLOYEE_EMAIL_LENGTH ||
    !EMPLOYEE_EMAIL_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function isEmployeeDirectoryRole(value: unknown): value is EmployeeDirectoryRole {
  return (
    typeof value === "string" && EMPLOYEE_DIRECTORY_ROLES.includes(value as EmployeeDirectoryRole)
  );
}
