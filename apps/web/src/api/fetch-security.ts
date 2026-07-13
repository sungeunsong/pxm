const nativeFetch = window.fetch.bind(window);

export function installSecureApiFetch() {
  window.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (isSameOriginApi(url) && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const csrf = readCookie('__Host-pxm_csrf') || readCookie('pxm_csrf');
      if (csrf) { const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined)); headers.set('x-csrf-token', csrf); init = { ...init, headers, credentials: 'include' }; }
    }
    return nativeFetch(input, init);
  }) as typeof window.fetch;
}

function isSameOriginApi(url: string) { try { const parsed = new URL(url, window.location.origin); return parsed.origin === window.location.origin && parsed.pathname.startsWith('/api/'); } catch { return false; } }
function readCookie(name: string) { for (const part of document.cookie.split(';')) { const [key, ...value] = part.trim().split('='); if (key === name) return decodeURIComponent(value.join('=')); } return null; }
