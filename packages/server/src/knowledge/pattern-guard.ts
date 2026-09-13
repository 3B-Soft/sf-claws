/**
 * Guard for model-supplied regular expressions.
 *
 * Our search tools take a regex from the model. JavaScript's engine backtracks, so a pattern with
 * nested quantifiers — `(a+)+b`, `(\d*)*$` — takes exponential time on input that nearly matches.
 * The regex runs on the shared event loop, so one such pattern stalls every other tenant's session,
 * not merely the search that asked for it. And the model's input is influenceable: a hostile string
 * in an org record or a linked repository can suggest one.
 *
 * Truncating the input line does not fix this — `(a+)+b` against 500 characters is still
 * effectively unbounded, as the test for this file demonstrates. The two real fixes are a
 * linear-time engine (RE2, a native dependency that would complicate self-hosting) or refusing the
 * dangerous shapes. We refuse the shapes: a conservative structural check that rejects a quantified
 * group containing its own unbounded quantifier.
 *
 * This is deliberately conservative. It rejects some patterns that would have been fine, and the
 * message says how to rewrite them. That trade is right when the alternative is a hang that takes
 * down other tenants.
 */

/** Longest pattern we will compile at all. */
export const MAX_PATTERN_CHARS = 400;

export class UnsafePatternError extends Error {
  override readonly name = 'UnsafePatternError';
}

/**
 * Throw when a pattern is unsafe to run against untrusted-length input.
 * Returns the compiled RegExp when it is safe.
 */
export function compileSafePattern(pattern: string, flags: string): RegExp {
  if (!pattern) throw new UnsafePatternError('Pattern is empty.');
  if (pattern.length > MAX_PATTERN_CHARS) {
    throw new UnsafePatternError(`Pattern is too long (${pattern.length} characters, limit ${MAX_PATTERN_CHARS}). Search for something more specific.`);
  }
  const risk = findNestedQuantifier(pattern);
  if (risk) {
    throw new UnsafePatternError(
      `Pattern rejected: "${risk}" nests one repetition inside another, which can take exponential time to match and would stall the server. ` +
        'Rewrite it without the nesting — for example prefer "\\\\w+" over "(\\\\w+)+", or search for a literal fragment and narrow with a glob.',
    );
  }
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    throw new UnsafePatternError(`Invalid regular expression: ${(e as Error).message}`);
  }
}

/** Quantifiers that can repeat unboundedly. `{n,m}` is bounded and therefore not the problem. */
const UNBOUNDED = new Set(['*', '+']);

/**
 * Find a group whose contents contain an unbounded quantifier and which is itself unbounded —
 * the `(a+)+` shape. Walks the pattern tracking group spans; deliberately simple, because a clever
 * parser here would be harder to trust than a blunt one.
 */
function findNestedQuantifier(pattern: string): string | null {
  const openStack: number[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      i++;
      continue;
    } // escaped character, never structural
    if (c === '[') {
      i = skipCharClass(pattern, i);
      continue;
    }
    if (c === '(') {
      openStack.push(i);
      continue;
    }
    if (c !== ')') continue;

    const start = openStack.pop();
    if (start === undefined) continue;
    const quantifier = quantifierAfter(pattern, i);
    if (!quantifier) continue;

    // The group repeats. If its body also repeats unboundedly, matching can blow up.
    const body = pattern.slice(start + 1, i);
    if (containsUnboundedQuantifier(body)) return `${pattern.slice(start, i + 1)}${quantifier}`;
  }
  return null;
}

/** The quantifier immediately after position i, if it is an unbounded one. */
function quantifierAfter(pattern: string, i: number): string | null {
  const next = pattern[i + 1];
  if (next && UNBOUNDED.has(next)) return next;
  // {n,} is unbounded above; {n,m} is not.
  const m = /^\{\d*,\}/.exec(pattern.slice(i + 1));
  return m ? m[0] : null;
}

function containsUnboundedQuantifier(body: string): boolean {
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') {
      i = skipCharClass(body, i);
      continue;
    }
    if (UNBOUNDED.has(c)) {
      // `*` or `+` directly after `(` is a literal-ish edge case, not a quantifier.
      if (i === 0) continue;
      return true;
    }
    if (c === '{' && /^\{\d*,\}/.test(body.slice(i))) return true;
  }
  return false;
}

/** Index of the closing `]` of a character class starting at `start`. */
function skipCharClass(pattern: string, start: number): number {
  for (let i = start + 1; i < pattern.length; i++) {
    if (pattern[i] === '\\') {
      i++;
      continue;
    }
    if (pattern[i] === ']') return i;
  }
  return pattern.length;
}
