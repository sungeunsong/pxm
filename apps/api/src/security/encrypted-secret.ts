import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

export type EncryptedSecret = {
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
};

export function assertConfiguredSecretKey(): void {
  getSecretKey();
}

export function encryptSecret(secret: string): EncryptedSecret {
  const key = getSecretKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptSecret(secret: EncryptedSecret): string {
  const key = getSecretKey();
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(secret.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function getSecretKey(): Buffer {
  const configured = process.env.CREDENTIAL_SECRET_KEY;
  if (
    process.env.NODE_ENV === 'production' &&
    (!configured || configured.length < 32)
  ) {
    throw new Error(
      'CREDENTIAL_SECRET_KEY must be configured with at least 32 characters in production',
    );
  }
  const source = configured || 'pxm-local-development-credential-key';
  return createHash('sha256').update(source).digest();
}
