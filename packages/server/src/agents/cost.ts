/**
 * Spend ceilings.
 *
 * A swarm can spend real money before anyone looks at the panel: a stuck builder loop with parallel
 * sub-agents on a frontier model is expensive per minute. Ceilings are therefore checked *before*
 * each model call — checking afterwards only reports money already gone.
 *
 * The configured ceiling is a hard cap that is never exceeded. `costCeilingDocReserveUsd` is carved
 * out of it rather than added on top: ordinary agents stop at `limit - reserve`, and only the
 * documentation guarantee may spend into the remaining slice. That way hitting a ceiling can never
 * leave a session with staged, validated, undocumented work — and the number an admin typed is
 * still the real maximum.
 */
import type { PolicyRules } from '@sf-claws/shared';

export type CostScope = 'turn' | 'session' | 'client_month';

export class CostCeilingError extends Error {
  override readonly name = 'CostCeilingError';
  constructor(
    public scope: CostScope,
    public limitUsd: number,
    public spentUsd: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CostSnapshot {
  /** Spend inside the current turn (all agents, including sub-agents). */
  turnCostUsd: number;
  /** Lifetime spend of this session. */
  sessionCostUsd: number;
  /** This client's spend in the current calendar month. */
  clientMonthCostUsd: number;
}

export interface CostCheckInput extends CostSnapshot {
  rules: Pick<PolicyRules, 'maxTurnCostUsd' | 'maxSessionCostUsd' | 'maxClientMonthlyCostUsd' | 'costCeilingDocReserveUsd'>;
  /** True only for the documentation guarantee, which may spend into the reserved slice. */
  documenting?: boolean;
  /** What the call about to be made will cost at list price; refused when it would cross a ceiling. */
  projectedUsd?: number;
}

/**
 * The price of one call before it is made: estimated input tokens at the input rate plus the full
 * output slot at the output rate. Deliberately pessimistic — cached reads are cheaper and the model
 * rarely fills the slot — because the alternative is discovering the overshoot after the bill.
 */
export function projectCallCostUsd(model: { inputCostPerM: number; outputCostPerM: number }, inputTokens: number, outputTokens: number): number {
  return (Math.max(0, inputTokens) * model.inputCostPerM + Math.max(0, outputTokens) * model.outputCostPerM) / 1_000_000;
}

/** The ceiling this call would cross, or null when it is within budget. */
export function checkCostCeilings(input: CostCheckInput): CostCeilingError | null {
  const { rules, documenting } = input;
  const projected = Math.max(0, input.projectedUsd ?? 0);
  const reserve = documenting ? 0 : Math.max(0, rules.costCeilingDocReserveUsd ?? 0);
  const checks: { scope: CostScope; limit: number; spent: number; label: string }[] = [
    { scope: 'turn', limit: rules.maxTurnCostUsd, spent: input.turnCostUsd, label: 'this turn' },
    { scope: 'session', limit: rules.maxSessionCostUsd, spent: input.sessionCostUsd, label: 'this session' },
    { scope: 'client_month', limit: rules.maxClientMonthlyCostUsd, spent: input.clientMonthCostUsd, label: "this client's monthly budget" },
  ];
  for (const c of checks) {
    if (!c.limit || c.limit <= 0) continue; // 0 = unlimited
    // Ordinary work must leave the reserve untouched; the doc writer may use it.
    const usable = Math.max(0, c.limit - reserve);
    if (c.spent >= usable || c.spent + projected > usable) {
      const detail = reserve > 0 ? ` (${fmt(c.limit)} limit less a ${fmt(reserve)} reserve kept for writing documentation)` : '';
      const why = c.spent >= usable ? 'reached' : `would be crossed by the next call (about ${fmt(projected)})`;
      return new CostCeilingError(c.scope, c.limit, c.spent, `Spend ceiling ${why} for ${c.label}: ${fmt(c.spent)} of ${fmt(c.limit)}${detail}.`);
    }
  }
  return null;
}

/** First instant of the current UTC month, as an ISO string. */
export function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

const fmt = (n: number) => `$${n.toFixed(2)}`;
