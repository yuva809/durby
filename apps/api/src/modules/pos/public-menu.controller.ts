import { Controller, Get, Header, Param, Req } from '@nestjs/common';
import type { PublicMenu } from '@durby/shared';
import type { Request } from 'express';
import { Public } from '../../platform/auth';
import { PublicMenuService } from './public-menu.service';

/**
 * The public table menu (docs/modules/pos.md → QR menu, ADR 0026): no session, authenticated by
 * nothing but the table's menu link. Reads only; the service checks the `pos` feature itself
 * (`@RequireFeature` can't sit next to `@Public`).
 */
@Controller('public/menu')
export class PublicMenuController {
  constructor(private readonly menus: PublicMenuService) {}

  @Public()
  @Get(':token')
  @Header('Cache-Control', 'no-store')
  menu(@Param('token') token: string, @Req() req: Request): Promise<PublicMenu> {
    return this.menus.menu(token, clientIp(req));
  }
}

/** Client address as Express resolves it with `trust proxy` (TRUST_PROXY hops). */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
