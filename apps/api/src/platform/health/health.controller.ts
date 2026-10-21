import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthResponse } from '@durby/shared';
import { Public } from '../auth/public.decorator';
import { APP_CONFIG, type AppConfig } from '../config';

@Controller('health')
export class HealthController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Public()
  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      version: this.config.APP_VERSION,
      time: new Date().toISOString(),
    };
  }
}
