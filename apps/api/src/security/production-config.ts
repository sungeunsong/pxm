const MIN_SECRET_LENGTH = 32;
const WEAK_BOOTSTRAP_PASSWORDS = new Set([
  'admin',
  'admin1234',
  'password',
  'changeme',
  'replace-me',
]);

export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;

  const errors: string[] = [];
  if (env.DB_TYPE !== 'mongodb') {
    errors.push('DB_TYPE must be mongodb for the supported beta production profile');
  }
  validateMongoUrl(env.MONGODB_URL, errors);
  required(env.MONGO_DB_NAME, 'MONGO_DB_NAME', errors);
  strongSecret(env.CREDENTIAL_SECRET_KEY, 'CREDENTIAL_SECRET_KEY', errors);
  strongSecret(env.PXM_EXTERNAL_APPROVAL_SECRET, 'PXM_EXTERNAL_APPROVAL_SECRET', errors);
  validateBootstrapPassword(env.PXM_BOOTSTRAP_ADMIN_PASSWORD, errors);

  const publicUrl = required(env.PXM_PUBLIC_WEB_URL, 'PXM_PUBLIC_WEB_URL', errors);
  if (publicUrl && !isHttpsUrl(publicUrl)) {
    errors.push('PXM_PUBLIC_WEB_URL must use https in production');
  }
  if (!env.PXM_TRUST_PROXY?.trim() || ['0', 'false'].includes(env.PXM_TRUST_PROXY.trim().toLowerCase())) {
    errors.push('PXM_TRUST_PROXY must explicitly trust only the production reverse proxy');
  }
  for (const origin of csv(env.PXM_CORS_ORIGINS)) {
    if (!isHttpsUrl(origin)) errors.push(`PXM_CORS_ORIGINS contains a non-https origin: ${origin}`);
  }
  if (env.SMTP_HOST?.trim()) {
    if (env.SMTP_REQUIRE_TLS !== 'true' && env.SMTP_SECURE !== 'true') {
      errors.push('SMTP_REQUIRE_TLS or SMTP_SECURE must be true when SMTP is enabled in production');
    }
    strongSecret(env.SMTP_PASSWORD, 'SMTP_PASSWORD', errors);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid production configuration:\n- ${errors.join('\n- ')}`);
  }
}

function validateMongoUrl(value: string | undefined, errors: string[]) {
  const raw = required(value, 'MONGODB_URL', errors);
  if (!raw) return;
  try {
    const url = new URL(raw);
    if (!['mongodb:', 'mongodb+srv:'].includes(url.protocol)) {
      errors.push('MONGODB_URL must use mongodb:// or mongodb+srv://');
    }
    if (!url.username || !url.password) {
      errors.push('MONGODB_URL must include an authenticated application user');
    }
  } catch {
    errors.push('MONGODB_URL must be a valid MongoDB URL');
  }
}

function validateBootstrapPassword(value: string | undefined, errors: string[]) {
  const password = required(value, 'PXM_BOOTSTRAP_ADMIN_PASSWORD', errors);
  if (!password) return;
  if (password.length < 16) errors.push('PXM_BOOTSTRAP_ADMIN_PASSWORD must be at least 16 characters');
  if (WEAK_BOOTSTRAP_PASSWORDS.has(password.toLowerCase())) {
    errors.push('PXM_BOOTSTRAP_ADMIN_PASSWORD must not use a development default');
  }
}

function strongSecret(value: string | undefined, name: string, errors: string[]) {
  const secret = required(value, name, errors);
  if (secret && secret.length < MIN_SECRET_LENGTH) {
    errors.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
}

function required(value: string | undefined, name: string, errors: string[]) {
  const normalized = value?.trim();
  if (!normalized) errors.push(`${name} is required`);
  return normalized || '';
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function csv(value?: string) {
  return (value || '').split(',').map((item) => item.trim()).filter(Boolean);
}
