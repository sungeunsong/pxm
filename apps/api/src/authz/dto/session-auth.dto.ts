import { IsEmail, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @MaxLength(128)
  user_id: string;

  @IsString()
  @MaxLength(1024)
  password: string;
}

export class ChangePasswordDto {
  @IsString()
  @MaxLength(1024)
  current_password: string;

  @IsString()
  @MinLength(12)
  @MaxLength(1024)
  new_password: string;
}

export class UpdateProfileDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  display_name: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string | null;
}

export class UpdateSessionSecurityPolicyDto {
  @IsInt()
  @Min(5)
  @Max(120)
  idle_timeout_minutes: number;

  @IsInt()
  @Min(1)
  @Max(24)
  absolute_timeout_hours: number;

  @IsIn(['keep', 'revoke_others', 'revoke_all'])
  existing_sessions: 'keep' | 'revoke_others' | 'revoke_all';

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  current_password: string;
}
