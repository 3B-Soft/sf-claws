import { describe, expect, it } from 'vitest';
import { validationRequiredToResume } from '../src/lib/sessionRecovery.js';

describe('session validation recovery', () => {
  it('routes a Salesforce platform failure to manual validation', () => {
    expect(
      validationRequiredToResume({
        statusMessage: 'Salesforce returned a platform or test-level failure without component diagnostics.',
        deploys: [
          {
            attempt: 7,
            checkOnly: true,
            scope: 'slice',
            status: 'failed',
            failures: [{ problem: 'UNKNOWN_EXCEPTION: ErrorId 123 (-315522575)' }],
          },
        ],
      }),
    ).toBe(true);
  });

  it('allows resume after a later full validation succeeds', () => {
    expect(
      validationRequiredToResume({
        statusMessage: 'Salesforce returned a platform or test-level failure without component diagnostics.',
        deploys: [
          { attempt: 7, checkOnly: true, scope: 'slice', status: 'failed', failures: [{ problem: 'UNKNOWN_EXCEPTION' }] },
          { attempt: 8, checkOnly: true, scope: 'full', status: 'succeeded', failures: [] },
        ],
      }),
    ).toBe(false);
  });

  it('does not divert ordinary provider failures', () => {
    expect(validationRequiredToResume({ statusMessage: 'Stopped: the AI provider request failed.', deploys: [] })).toBe(false);
  });
});
