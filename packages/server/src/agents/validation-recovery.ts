import type { AppContext } from '../app-context.js';
import type { Checkpoint } from '../db/repos/harness.js';
import type { DeployOutcome } from '../salesforce/service.js';
import { sha256 } from '../lib/crypto.js';
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Cancelled during platform backoff'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('Cancelled during platform backoff'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export type FailureKind = 'platform' | 'auth' | 'quota' | 'transport' | 'component' | 'test' | 'coverage' | 'cancelled' | 'unknown';
export function classifyFailure(value: unknown): FailureKind {
  const outcome = value && typeof value === 'object' && 'failures' in value ? (value as DeployOutcome) : null;
  const text =
    value instanceof Error
      ? `${value.message} ${JSON.stringify((value as any).details ?? {})}`
      : outcome
        ? `${outcome.status} ${outcome.errorMessage ?? ''} ${JSON.stringify(outcome.failures)}`
        : JSON.stringify(value);
  if (/INVALID_SESSION_ID|INVALID_LOGIN|INSUFFICIENT_ACCESS|insufficient privileges|unauthorized/i.test(text)) return 'auth';
  if (/REQUEST_LIMIT_EXCEEDED|API limit|quota/i.test(text)) return 'quota';
  if (/UNKNOWN_EXCEPTION|UNABLE_TO_LOCK_ROW|ENTITY_IS_LOCKED/i.test(text)) return 'platform';
  if (/ECONNRESET|ETIMEDOUT|network|fetch failed|socket|timed out/i.test(text)) return 'transport';
  if (/CodeCoverage|coverage/i.test(text)) return 'coverage';
  if (/TestFailure/i.test(text)) return 'test';
  if (/Canceled|Canceling|Aborted/i.test(text)) return 'cancelled';
  if (typeof value === 'object' && value && 'failures' in value && (value as DeployOutcome).failures.some((f) => f.componentType)) return 'component';
  return 'unknown';
}

/** Retry terminal platform failures only. Lost acknowledgements are reconciled, never resubmitted. */
export async function executeCheckpoint(
  app: AppContext,
  checkpoint: Checkpoint,
  opts: { signal?: AbortSignal; progress?: (message: string) => void } = {},
): Promise<DeployOutcome> {
  const repo = app.repos.harness;
  const { sessionId, id, payload, orgId } = checkpoint;
  if (sha256(JSON.stringify(payload)) !== checkpoint.payloadHash) throw new Error('Archived payload checksum mismatch');
  if (app.repos.orgs.byId(orgId)?.apiVersion !== payload.apiVersion) throw new Error('Org API version changed; archived job requires manual reconciliation');
  const history = repo.attempts(sessionId, id);
  let attempt = history.at(-1);
  let nextNumber = (attempt?.number ?? 0) + 1;
  for (;;) {
    if (attempt?.phase === 'finished' && attempt.outcome) {
      if (classifyFailure(attempt.outcome) !== 'platform' || !checkpoint.checkOnly || attempt.number >= 3) return attempt.outcome;
      if (opts.signal?.aborted) throw new Error('Cancelled before platform retry');
      attempt.retryAt ??= Date.now() + Math.round((attempt.number === 1 ? 15_000 : 45_000) * (0.9 + Math.random() * 0.2));
      repo.attempt(sessionId, id, attempt);
      opts.progress?.(`Platform failure; retrying the identical archived payload (attempt ${attempt.number + 1}/3). No code repair is indicated.`);
      await delay(Math.max(0, attempt.retryAt - Date.now()), opts.signal);
      nextNumber = attempt.number + 1;
      attempt = undefined;
    }
    if (!attempt) {
      if (opts.signal?.aborted) throw new Error('Cancelled before validation submission');
      const number = nextNumber;
      if (number > 3) throw new Error('Validation retry budget exhausted');
      attempt = { number, phase: 'submitting', startedAt: new Date().toISOString() };
      repo.startAttempt(sessionId, id, attempt);
      try {
        const callbacks = {
          onProgress: opts.progress,
          onContainer: (containerId: string) => {
            attempt!.containerId = containerId;
            repo.attempt(sessionId, id, attempt!);
          },
          onSubmitted: (remoteId: string) => {
            attempt!.remoteId = remoteId;
            attempt!.phase = 'polling';
            repo.attempt(sessionId, id, attempt!);
            app.repos.deploys.update(checkpoint.deployId, { sfDeployId: remoteId });
          },
        };
        const outcome =
          checkpoint.engine === 'tooling'
            ? await app.sf.toolingCompile(orgId, payload.members!, callbacks)
            : await app.sf.deploy(orgId, payload.files, {
                checkOnly: checkpoint.checkOnly,
                testLevel: payload.testLevel,
                runTests: payload.runTests,
                deleted: payload.deleted,
                preparedZip: payload.zipBase64 ? Buffer.from(payload.zipBase64, 'base64') : undefined,
                ...callbacks,
              });
        attempt.outcome = outcome;
        attempt.phase = 'finished';
      } catch (error) {
        attempt.error = (error as Error).message;
        // An explicit Salesforce platform fault without a job acknowledgement can be retried for check-only calls.
        const kind = classifyFailure(error);
        if (!attempt.remoteId && ((kind === 'platform' && checkpoint.checkOnly) || kind === 'auth' || kind === 'quota')) {
          attempt.phase = 'finished';
          attempt.outcome = platformOutcome(attempt.error);
        } else {
          attempt.phase = 'uncertain';
          repo.attempt(sessionId, id, attempt);
          repo.finish(sessionId, id, 'uncertain', null);
          throw new Error(`Validation outcome is uncertain; reconcile checkpoint ${id} before submitting more work. ${attempt.error}`);
        }
      }
      if (attempt.phase === 'finished') attempt.finishedAt = new Date().toISOString();
      repo.attempt(sessionId, id, attempt);
    } else if (attempt.phase !== 'finished') {
      // This path is entered after a restart or an explicit manual retry of an uncertain job.
      try {
        if (!attempt.remoteId && checkpoint.engine === 'tooling' && attempt.containerId) {
          const job = await app.sf.findToolingJob(orgId, attempt.containerId);
          if (job) {
            attempt.remoteId = job.id;
            repo.attempt(sessionId, id, attempt);
          }
        }
        if (!attempt.remoteId) throw new Error('No acknowledged job ID; inspect Salesforce status manually. Automatic resubmission is unsafe.');
        attempt.outcome = await app.sf.resumeValidation(orgId, checkpoint.engine, attempt.remoteId, {
          checkOnly: checkpoint.checkOnly,
          testLevel: payload.testLevel,
          runTests: payload.runTests,
          containerId: attempt.containerId,
          onProgress: opts.progress,
        });
        attempt.phase = 'finished';
        attempt.finishedAt = new Date().toISOString();
        repo.attempt(sessionId, id, attempt);
      } catch (error) {
        repo.finish(sessionId, id, 'uncertain', null);
        throw error;
      }
    }
    if (attempt.containerId && attempt.phase === 'finished') {
      await app.sf
        .cleanupToolingContainer(orgId, attempt.containerId)
        .catch((error) => app.log.warn({ checkpointId: id, err: (error as Error).message }, 'compiler container cleanup failed'));
    }
  }
}

function platformOutcome(message: string): DeployOutcome {
  return {
    ok: false,
    checkOnly: true,
    sfDeployId: '',
    status: 'Failed',
    componentsTotal: 0,
    componentsDeployed: 0,
    componentsFailed: 0,
    testsTotal: 0,
    testsFailed: 0,
    codeCoverage: null,
    runCoverage: null,
    orgWideCoverage: null,
    validationId: null,
    cancelled: false,
    testFailures: [],
    coverageWarnings: [],
    errorMessage: message,
    failures: [{ componentType: null, fullName: null, fileName: null, problem: message, problemType: 'Platform', lineNumber: null, columnNumber: null }],
  };
}
