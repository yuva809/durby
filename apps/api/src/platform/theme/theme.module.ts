import { Module } from '@nestjs/common';
import { PLATFORM_PRISMA, type PlatformPrismaClient } from '../tenancy';
import { ThemeController } from './theme.controller';
import { ThemeService } from './theme.service';

/** Partner theming by domain (docs/platform/web-shell.md, ADR 0015). Platform tables only, through the platform client (never the raw one, ADR 0005 §6). */
@Module({
  controllers: [ThemeController],
  providers: [
    {
      provide: ThemeService,
      useFactory: (prisma: PlatformPrismaClient) => new ThemeService(prisma),
      inject: [PLATFORM_PRISMA],
    },
  ],
})
export class ThemeModule {}
