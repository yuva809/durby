import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { HealthResponse, LiveResponse } from '@durby/shared';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Readiness: database and Redis. 503 when either is down. Used by deploy checks and monitoring. */
  @Public()
  @Get()
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const report = await this.health.readiness();
    if (report.status !== 'ok') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }

  /** Liveness: the process answers. No dependencies, so a DB blip never marks the container unhealthy. */
  @Public()
  @Get('live')
  live(): LiveResponse {
    return this.health.live();
  }
}
