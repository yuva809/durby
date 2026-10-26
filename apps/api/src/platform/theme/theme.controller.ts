import { Controller, Get, Header, Req } from '@nestjs/common';
import type { ThemeResponse } from '@durby/shared';
import type { Request } from 'express';
import { Public } from '../markers';
import { ThemeService } from './theme.service';

@Controller('theme')
export class ThemeController {
  constructor(private readonly themes: ThemeService) {}

  /**
   * The theme of the partner behind the request's host (`X-Forwarded-Host` only behind a trusted
   * proxy), or the default theme. Public: no tenant data. `no-store`: the body depends on the host.
   */
  @Public()
  @Get()
  @Header('Cache-Control', 'no-store')
  get(@Req() req: Request): Promise<ThemeResponse> {
    return this.themes.forHost(req.hostname);
  }
}
