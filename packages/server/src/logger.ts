import pino from 'pino';
export type Logger = pino.Logger;

/** Query parameters that carry credentials and must never reach a log line. */
const SECRET_QUERY_PARAMS = new Set(['token', 'access_token', 'code', 'state']);

/**
 * Strip credential-bearing query parameters from a URL before it is logged. The SSE stream
 * authenticates with `?token=<jwt>` because EventSource cannot set headers, so without this every
 * stream open would write a 72-hour bearer token into the access log. The value is replaced, not
 * removed, so the log still shows that a token was presented.
 */
export function redactUrl(url: string): string {
  if (!url?.includes('?')) return url;
  const [path, query = ''] = url.split('?', 2);
  const redacted = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const key = eq < 0 ? pair : pair.slice(0, eq);
      return SECRET_QUERY_PARAMS.has(key.toLowerCase()) ? `${key}=[REDACTED]` : pair;
    })
    .join('&');
  return `${path}?${redacted}`;
}

/** Same shape as Fastify's default request serializer, with the URL scrubbed. */
export function serializeRequest(req: any): Record<string, unknown> {
  return {
    method: req?.method,
    url: redactUrl(String(req?.url ?? '')),
    version: req?.headers?.['accept-version'],
    host: req?.host ?? req?.hostname,
    remoteAddress: req?.ip,
    remotePort: req?.socket?.remotePort,
  };
}

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } } : {}),
    redact: ['req.headers.authorization', '*.apiKey', '*.token', '*.password'],
    // Fastify merges these over its own defaults, so every `{ req }` log line goes through redactUrl.
    serializers: { req: serializeRequest },
  });
}
