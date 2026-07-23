import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const RUNTIME_INTEGRITY_FINDING_TYPES = [
  'ORPHAN_JOB',
  'ORPHAN_TOKEN',
  'ORPHAN_TASK',
  'STALLED_INSTANCE',
  'WAITING_APPROVAL_WITHOUT_TASK',
  'INSTANCE_MISSING_DEFINITION',
] as const;

export type RuntimeIntegrityFindingType =
  (typeof RUNTIME_INTEGRITY_FINDING_TYPES)[number];

export class RuntimeIntegrityScanDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(86_400)
  min_age_seconds?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class RuntimeIntegrityRepairDto {
  @IsIn(RUNTIME_INTEGRITY_FINDING_TYPES)
  finding_type!: RuntimeIntegrityFindingType;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  resource_id!: string;

  @IsISO8601()
  observed_updated_at!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
