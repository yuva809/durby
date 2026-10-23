import { Module } from '@nestjs/common';
import { PrismaService } from '../database';
import { ThemeController } from './theme.controller';
import { ThemeService } from './theme.service';

/** Partner theming by domain (docs/platform/web-shell.md, ADR 0015). Depends on database only. */
@Module({
  controllers: [ThemeController],
  providers: [
    {
      provide: ThemeService,
      useFactory: (prisma: PrismaService) => new ThemeService(prisma),
      inject: [PrismaService],
    },
  ],
})
export class ThemeModule {}
