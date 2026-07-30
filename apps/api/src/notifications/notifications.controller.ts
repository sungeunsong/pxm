import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { actorFromRequest } from '../instances/history-auth';
import { NotificationQueryDto, RetryNotificationDto } from './dto/notification.dto';
import { NotificationService } from './notification.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  @Get('deliveries')
  list(@Query() query: NotificationQueryDto, @Req() req: Request) {
    return this.notifications.list(query, actorFromRequest(req));
  }

  @Get('deliveries/:id')
  detail(@Param('id') id: string, @Req() req: Request) {
    return this.notifications.detail(id, actorFromRequest(req));
  }

  @Post('deliveries/:id/retry')
  retry(@Param('id') id: string, @Body() body: RetryNotificationDto, @Req() req: Request) {
    return this.notifications.retry(id, body.reason, actorFromRequest(req));
  }
}
