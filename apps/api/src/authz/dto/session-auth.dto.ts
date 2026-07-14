import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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
