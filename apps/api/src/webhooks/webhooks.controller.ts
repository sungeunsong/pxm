import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { actorFromRequest } from '../instances/history-auth';
import {
  CreateWebhookEndpointDto,
  UpdateWebhookEndpointDto,
  WebhookDeliveryQueryDto,
} from './dto/webhook.dto';
import { WebhookDeliveryService } from './webhook-delivery.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhookDeliveryService) {}

  @Post('endpoints')
  createEndpoint(
    @Body() dto: CreateWebhookEndpointDto,
    @Req() req: Request,
  ) {
    return this.webhooks.createEndpoint(dto, actorFromRequest(req));
  }

  @Get('endpoints')
  listEndpoints(@Req() req: Request) {
    return this.webhooks.listEndpoints(actorFromRequest(req));
  }

  @Put('endpoints/:id')
  updateEndpoint(
    @Param('id') id: string,
    @Body() dto: UpdateWebhookEndpointDto,
    @Req() req: Request,
  ) {
    return this.webhooks.updateEndpoint(id, dto, actorFromRequest(req));
  }

  @Get('deliveries')
  listDeliveries(
    @Query() query: WebhookDeliveryQueryDto,
    @Req() req: Request,
  ) {
    return this.webhooks.listDeliveries(query, actorFromRequest(req));
  }

  @Get('deliveries/:id')
  getDelivery(@Param('id') id: string, @Req() req: Request) {
    return this.webhooks.getDelivery(id, actorFromRequest(req));
  }

  @Post('deliveries/:id/retry')
  retryDelivery(@Param('id') id: string, @Req() req: Request) {
    return this.webhooks.retryDelivery(id, actorFromRequest(req));
  }
}
