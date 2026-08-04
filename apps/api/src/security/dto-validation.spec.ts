import { ValidationPipe } from '@nestjs/common';
import { CreateApiKeyDto } from '../authz/dto/authz.dto';
import { LoginDto } from '../authz/dto/session-auth.dto';
import { CreateCredentialDto } from '../credentials/dto/credential.dto';
import { CreateWebhookEndpointDto } from '../webhooks/dto/webhook.dto';

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: false,
});

function bodyMetadata(metatype: Function) {
  return { type: 'body' as const, metatype, data: undefined };
}

describe('security-sensitive DTO validation', () => {
  it('rejects unknown login fields', async () => {
    await expect(pipe.transform(
      { user_id: 'admin', password: 'password', role: 'admin' },
      bodyMetadata(LoginDto),
    )).rejects.toMatchObject({ status: 400 });
  });

  it('rejects invalid API key scopes', async () => {
    await expect(pipe.transform({
      name: 'integration',
      owner_type: 'SERVICE_ACCOUNT',
      owner_id: 'svc-1',
      group_id: 'group-1',
      scopes: ['admin:all'],
    }, bodyMetadata(CreateApiKeyDto))).rejects.toMatchObject({ status: 400 });
  });

  it('accepts an API key policy with an IPv4 CIDR', async () => {
    await expect(pipe.transform({
      name: 'integration',
      owner_type: 'SERVICE_ACCOUNT',
      owner_id: 'svc-1',
      group_id: 'group-1',
      scopes: ['workflow:execute'],
      ip_allowlist: ['10.0.0.0/8'],
      rate_limit_per_minute: 60,
    }, bodyMetadata(CreateApiKeyDto))).resolves.toBeInstanceOf(CreateApiKeyDto);
  });

  it('rejects active in a credential create payload', async () => {
    await expect(pipe.transform({
      group_id: 'group-1',
      name: 'integration',
      type: 'api_key',
      secret_value: 'secret',
      active: true,
    }, bodyMetadata(CreateCredentialDto))).rejects.toMatchObject({ status: 400 });
  });

  it('rejects short webhook secrets and unknown security fields', async () => {
    await expect(pipe.transform({
      name: 'AcraPoint',
      source_provider: 'acrapoint',
      url: 'https://example.test/webhook',
      secret: 'short',
      authorization: 'do-not-accept',
    }, bodyMetadata(CreateWebhookEndpointDto))).rejects.toMatchObject({ status: 400 });
  });

  it('accepts a signed webhook endpoint policy', async () => {
    await expect(pipe.transform({
      name: 'AcraPoint',
      source_provider: 'acrapoint',
      url: 'https://example.test/webhook',
      secret: 'a'.repeat(32),
      timeout_ms: 5000,
      max_attempts: 8,
    }, bodyMetadata(CreateWebhookEndpointDto))).resolves.toBeInstanceOf(CreateWebhookEndpointDto);
  });
});
