const BASE_CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

/**
 * The room SPA is served by the same process as the API, so CORS only matters
 * for external tooling. Default is permissive ('*') — the service is meant to
 * sit behind a private network; restrict via ROOM_ALLOWED_ORIGINS when it
 * doesn't.
 */
export function getAllowedOrigins(envValue?: string): string[] {
  if (envValue) {
    return envValue.split(',').map((o) => o.trim());
  }
  return ['*'];
}

export function corsHeaders(
  requestOrigin: string,
  allowedOrigins: string[]
): Record<string, string> {
  const isLocalhost = /^https?:\/\/localhost(:\d+)?$/.test(requestOrigin);
  if (allowedOrigins.includes('*')) {
    return { ...BASE_CORS_HEADERS, 'Access-Control-Allow-Origin': '*' };
  }
  if (isLocalhost || allowedOrigins.includes(requestOrigin)) {
    return { ...BASE_CORS_HEADERS, 'Access-Control-Allow-Origin': requestOrigin };
  }
  return {};
}
