/**
 * A compile-controller stop cannot be cleared by starting another model turn. The user must inspect
 * the archived result and run a manual full validation; once that succeeds, ordinary resume is safe.
 */
export function validationRequiredToResume(state) {
  const message = String(state?.statusMessage || '');
  const validations = (state?.deploys || [])
    .filter((run) => run?.checkOnly && run.status !== 'cancelled')
    .slice()
    .sort((a, b) => (Number(b.attempt) || 0) - (Number(a.attempt) || 0) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const latest = validations[0];

  // A later successful full validation clears the persisted compile stop even though the session
  // row remains failed until its orchestrator is resumed.
  if (latest?.status === 'succeeded' && latest.scope !== 'slice') return false;
  if (
    latest?.status === 'failed' &&
    (latest.failures || []).some((failure) => /UNKNOWN_EXCEPTION|UNABLE_TO_LOCK_ROW|ENTITY_IS_LOCKED/i.test(failure?.problem || ''))
  )
    return true;

  return /Salesforce .*failure|Salesforce returned|validation .*before resuming|validate manually|compile (?:stopped|regressed)|compiler diagnosis/i.test(
    message,
  );
}
