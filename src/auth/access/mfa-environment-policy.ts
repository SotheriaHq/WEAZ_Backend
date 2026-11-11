/** Only trusted server configuration and a database-verified role belong here.
 * NODE_ENV is not the deployment tier: SIT also runs production Node builds. */
export function hasSuperAdminTestMfaException(
  currentRole: string,
  appEnvironment: string | undefined = process.env.APP_ENV,
): boolean {
  const environment =
    typeof appEnvironment === 'string'
      ? appEnvironment.trim().toLowerCase()
      : '';
  return (
    currentRole === 'SuperAdmin' &&
    (environment === 'sit' || environment === 'uat')
  );
}

export function requiredRecoveryApprovals(currentRole: string): 0 | 2 {
  return hasSuperAdminTestMfaException(currentRole) ? 0 : 2;
}
