import { corsOptions, trustProxySetting } from './http-security';

describe('HTTP security configuration', () => {
  it('allows configured origins and rejects unknown origins', () => {
    const options = corsOptions({ NODE_ENV: 'production', PXM_CORS_ORIGINS: 'https://pxm.example.com' });
    const origin = options.origin as Function;
    const allowed = jest.fn();
    const rejected = jest.fn();

    origin('https://pxm.example.com', allowed);
    origin('https://evil.example.com', rejected);

    expect(allowed).toHaveBeenCalledWith(null, true);
    expect(rejected.mock.calls[0][0]).toBeNull();
    expect(rejected.mock.calls[0][1]).toBe(false);
  });

  it('does not enable cross-origin access by default in production', () => {
    const options = corsOptions({ NODE_ENV: 'production' });
    const origin = options.origin as Function;
    const sameOrigin = jest.fn();
    const crossOrigin = jest.fn();

    origin(undefined, sameOrigin);
    origin('http://localhost:5174', crossOrigin);

    expect(sameOrigin).toHaveBeenCalledWith(null, true);
    expect(crossOrigin).toHaveBeenCalledWith(null, false);
  });

  it('requires an explicit trusted proxy hop or address list', () => {
    expect(trustProxySetting({})).toBe(false);
    expect(trustProxySetting({ PXM_TRUST_PROXY: '1' })).toBe(1);
    expect(trustProxySetting({ PXM_TRUST_PROXY: '10.0.0.1, 10.0.0.2' })).toEqual(['10.0.0.1', '10.0.0.2']);
  });
});
