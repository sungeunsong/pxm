import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { CredentialsService } from './credentials.service';
import { CreateCredentialDto, UpdateCredentialDto } from './dto/credential.dto';

@Controller('credentials')
export class CredentialsController {
  constructor(private readonly credentialsService: CredentialsService) {}

  @Post()
  async create(@Body() dto: CreateCredentialDto) {
    return this.credentialsService.create(dto);
  }

  @Get()
  async list(@Query('activeOnly') activeOnly?: string) {
    return this.credentialsService.list(activeOnly === 'true');
  }

  @Get('audit')
  async audit() {
    return this.credentialsService.audit();
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.credentialsService.get(id);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateCredentialDto) {
    return this.credentialsService.update(id, dto);
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    return this.credentialsService.delete(id);
  }

  @Get(':id/audit')
  async credentialAudit(@Param('id') id: string) {
    return this.credentialsService.audit(id);
  }
}
