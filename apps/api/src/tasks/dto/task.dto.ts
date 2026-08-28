import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class CompleteTaskDto {
  @IsIn(['approve', 'reject'])
  action!: 'approve' | 'reject';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;

  @IsOptional()
  @IsObject()
  result?: Record<string, any>;
}

export class HoldTaskDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}
