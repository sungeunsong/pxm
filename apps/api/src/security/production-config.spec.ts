import { validateProductionConfig } from './production-config';

const valid = {
  NODE_ENV: 'production',
  DB_TYPE: 'mongodb',
  MONGODB_URL: 'mongodb://pxm_app:strong-password@mongodb:27017/?replicaSet=rs0&authSource=pxm',
  MONGO_DB_NAME: 'pxm',
  CREDENTIAL_SECRET_KEY: 'c'.repeat(32),
  PXM_EXTERNAL_APPROVAL_SECRET: 'e'.repeat(32),
  PXM_BOOTSTRAP_ADMIN_PASSWORD: 'A-strong-bootstrap-password-2026',
  PXM_PUBLIC_WEB_URL: 'https://pxm.example.com',
  PXM_TRUST_PROXY: 'loopback,linklocal,uniquelocal',
  PXM_CORS_ORIGINS: 'https://pxm.example.com',
};

describe('production configuration', () => {
  it('accepts the supported secured MongoDB beta profile', () => {
    expect(() => validateProductionConfig(valid)).not.toThrow();
  });

  it('does not enforce production settings during development', () => {
    expect(() => validateProductionConfig({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('rejects defaults, unauthenticated storage and non-TLS public URLs together', () => {
    expect(() => validateProductionConfig({
      ...valid,
      DB_TYPE: 'postgres',
      MONGODB_URL: 'mongodb://mongodb:27017',
      PXM_BOOTSTRAP_ADMIN_PASSWORD: 'admin1234',
      PXM_PUBLIC_WEB_URL: 'http://pxm.example.com',
      PXM_TRUST_PROXY: 'false',
    })).toThrow(/DB_TYPE must be mongodb[\s\S]*authenticated application user[\s\S]*at least 16 characters[\s\S]*development default[\s\S]*https[\s\S]*PXM_TRUST_PROXY/);
  });

  it('requires TLS and a password when SMTP is configured', () => {
    expect(() => validateProductionConfig({ ...valid, SMTP_HOST: 'smtp.example.com' }))
      .toThrow(/SMTP_REQUIRE_TLS[\s\S]*SMTP_PASSWORD/);
  });
});
