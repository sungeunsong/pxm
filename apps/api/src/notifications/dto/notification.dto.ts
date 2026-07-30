import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class NotificationQueryDto {
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

export class RetryNotificationDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}
