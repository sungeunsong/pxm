const nativeFetch = window.fetch.bind(window);
export const AUTH_REQUIRED_EVENT = 'pxm:auth-required';

export function installSecureApiFetch() {
  window.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (isSameOriginApi(url) && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const csrf = readCookie('__Host-pxm_csrf') || readCookie('pxm_csrf');
      if (csrf) { const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined)); headers.set('x-csrf-token', csrf); init = { ...init, headers, credentials: 'include' }; }
    }
    const response = await nativeFetch(input, init);
    if (response.status === 401 && isSameOriginApi(url) && !isHandledAuthRequest(url)) {
      window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
    }
    return response;
  }) as typeof window.fetch;
}

function isSameOriginApi(url: string) { try { const parsed = new URL(url, window.location.origin); return parsed.origin === window.location.origin && parsed.pathname.startsWith('/api/'); } catch { return false; } }
function isHandledAuthRequest(url: string) {
  try {
    const pathname = new URL(url, window.location.origin).pathname;
    return ['/api/auth/login', '/api/auth/me'].includes(pathname) || pathname.startsWith('/api/external-approvals/');
  } catch {
    return false;
  }
}
function readCookie(name: string) { for (const part of document.cookie.split(';')) { const [key, ...value] = part.trim().split('='); if (key === name) return decodeURIComponent(value.join('=')); } return null; }
