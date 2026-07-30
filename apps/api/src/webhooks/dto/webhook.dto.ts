import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateWebhookEndpointDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  source_provider: string;

  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(2048)
  url: string;

  @IsString()
  @MinLength(32)
  @MaxLength(1024)
  secret: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(500)
  @Max(30_000)
  timeout_ms?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  max_attempts?: number;
}

export class UpdateWebhookEndpointDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  source_provider?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsString()
  @MinLength(32)
  @MaxLength(1024)
  secret?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  @Min(500)
  @Max(30_000)
  timeout_ms?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  max_attempts?: number;
}

export class WebhookDeliveryQueryDto {
  @IsOptional()
  @IsString()
  endpoint_id?: string;

  @IsOptional()
  @IsIn(['PENDING', 'RUNNING', 'SENT', 'FAILED', 'DEAD_LETTER', 'CANCELED'])
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
