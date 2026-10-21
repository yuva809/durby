import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@durby/shared';
import { Public } from '../auth/public.decorator';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      version: process.env.APP_VERSION ?? '0.0.0-dev',
      time: new Date().toISOString(),
    };
  }
}
