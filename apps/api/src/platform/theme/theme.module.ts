import { Global, Module } from '@nestjs/common';
import { PLATFORM_PRISMA, type PlatformPrismaClient } from '../tenancy';
import { HostPartners } from './host-partners';
import { ThemeController } from './theme.controller';
import { ThemeService } from './theme.service';

/** Partner theming by domain (docs/platform/web-shell.md, ADR 0015). Platform tables only, through the platform client (never the raw one, ADR 0005 §6). */
@Global()
@Module({
  controllers: [ThemeController],
  providers: [
    {
      provide: ThemeService,
      useFactory: (prisma: PlatformPrismaClient) => new ThemeService(prisma),
      inject: [PLATFORM_PRISMA],
    },
    HostPartners,
  ],
  // Public pages that act for an organization check its partner against the request's host (ADR 0085).
  exports: [HostPartners],
})
export class ThemeModule {}
