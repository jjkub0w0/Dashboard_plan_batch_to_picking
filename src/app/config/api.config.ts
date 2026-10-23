/**
 * Base URL for backend API calls - always the relative '/api'.
 * Every supported entry point (unified runner on 1727, backend on 1726, Docker on
 * 9999/8888, and `ng serve` via proxy.conf.json) serves or proxies /api on the SAME
 * origin, so no absolute-port branch is needed. The old port-4200 branch bypassed
 * proxy.conf.json and hit 1726 directly, which no browser can read (API has no CORS).
 */

export function getBackendBaseUrl(): string {
  if (typeof window !== 'undefined' && window.location) {
    return '/api';
  }
  return '/api';
}

export function getApiUrl(endpoint: string, params?: Record<string, string | number | boolean | undefined>): string {
  const base = getBackendBaseUrl();
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  let url = `${base}${cleanEndpoint}`;

  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, val] of Object.entries(params)) {
      if (val !== undefined && val !== null && val !== '') {
        searchParams.set(key, String(val));
      }
    }
    const qs = searchParams.toString();
    if (qs) {
      url += (url.includes('?') ? '&' : '?') + qs;
    }
  }

  return url;
}
