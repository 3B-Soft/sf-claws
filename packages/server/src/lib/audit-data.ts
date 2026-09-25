/** Retain observable decisions and tool evidence, excluding credentials and provider-private blocks. */
export function auditData(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => !v || !['thinking', 'redacted_thinking', 'reasoning'].includes(v.type)).map(auditData);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'raw') continue;
      result[key] = /^(authorization|cookie|password|accessToken|refreshToken|apiKey|clientSecret|sessionToken)$/i.test(key) ? '[REDACTED]' : auditData(item);
    }
    return result;
  }
  return value;
}
