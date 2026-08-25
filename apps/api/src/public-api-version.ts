import { VERSION_NEUTRAL, VersioningType, type INestApplication } from '@nestjs/common';
import type { VersionValue } from '@nestjs/common/interfaces';

// Keep the unversioned routes during beta migration while exposing the public
// contract at /api/v1. Internal management endpoints remain /api only.
export const PUBLIC_API_VERSIONS: VersionValue = [VERSION_NEUTRAL, '1'];

export function enablePublicApiVersioning(app: Pick<INestApplication, 'enableVersioning'>) {
  app.enableVersioning({ type: VersioningType.URI });
}
