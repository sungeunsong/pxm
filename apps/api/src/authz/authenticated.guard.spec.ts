import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedGuard, developmentBypassEnabled } from './authenticated.guard';

describe('AuthenticatedGuard', () => {
  const reflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;
  const guard = new AuthenticatedGuard(reflector);

  beforeEach(() => jest.clearAllMocks());

  it('allows explicitly public routes', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(true);
    expect(guard.canActivate(contextFor({}))).toBe(true);
  });

  it('allows a session or API key actor', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(false);
    expect(guard.canActivate(contextFor({ workflowActor: { actor_id: 'admin' } }))).toBe(true);
  });

  it('rejects anonymous requests by default', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(false);
    expect(() => guard.canActivate(contextFor({}))).toThrow(UnauthorizedException);
  });

  it('never enables the development bypass in production', () => {
    expect(developmentBypassEnabled({ NODE_ENV: 'production', AUTHZ_ALLOW_DEVELOPMENT_BYPASS: 'true' })).toBe(false);
    expect(developmentBypassEnabled({ NODE_ENV: 'development', AUTHZ_ALLOW_DEVELOPMENT_BYPASS: 'true' })).toBe(true);
  });
});

function contextFor(request: Record<string, unknown>) {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as any;
}
