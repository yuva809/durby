import { Global, Module } from '@nestjs/common';
import { PoolReporter } from './pool-reporter';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, PoolReporter],
  exports: [PrismaService],
})
export class DatabaseModule {}
