import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class TaskHistoryQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  workflow_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  instance_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(254)
  assignee?: string;

  @IsOptional()
  @IsIn(['pxm_user', 'external_email'])
  approver_channel?: 'pxm_user' | 'external_email';

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
