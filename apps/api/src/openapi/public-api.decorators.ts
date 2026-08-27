import { applyDecorators } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiHeader,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { PublicApiErrorDto } from './public-api.dto';

export function PublicApiController() {
  return applyDecorators(
    ApiBearerAuth('api-key'),
    ApiHeader({
      name: 'X-Request-ID',
      required: false,
      description: '호출자가 지정하는 요청 추적 ID. 생략하면 서버가 생성합니다.',
      example: 'client-request-42',
    }),
    ApiExtraModels(PublicApiErrorDto),
  );
}

export function PublicApiErrors() {
  return applyDecorators(
    ApiUnauthorizedResponse({ description: 'API Key가 없거나 유효하지 않음', type: PublicApiErrorDto }),
    ApiForbiddenResponse({ description: '필요한 scope가 없음', type: PublicApiErrorDto }),
    ApiNotFoundResponse({ description: '리소스가 없거나 접근 범위 밖임', type: PublicApiErrorDto }),
    ApiInternalServerErrorResponse({ description: '내부 정보가 제거된 서버 오류', type: PublicApiErrorDto }),
  );
}
