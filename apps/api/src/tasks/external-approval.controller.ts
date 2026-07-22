import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Public } from '../authz/public-route';
import { CompleteExternalApprovalDto } from './dto/external-approval.dto';
import { ExternalApprovalService } from './external-approval.service';

@Public()
@Controller('external-approvals')
export class ExternalApprovalController {
  constructor(private readonly approvals: ExternalApprovalService) {}

  @Get(':token')
  getDetails(@Param('token') token: string) {
    return this.approvals.getDetails(token);
  }

  @Post(':token/otp')
  requestOtp(@Param('token') token: string) {
    return this.approvals.requestOtp(token);
  }

  @Post(':token/complete')
  complete(
    @Param('token') token: string,
    @Body() body: CompleteExternalApprovalDto,
  ) {
    return this.approvals.complete(token, body);
  }
}
