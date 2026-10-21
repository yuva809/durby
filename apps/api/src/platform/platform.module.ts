import { Module } from '@nestjs/common';
import { ConfigModule } from './config';
import { DatabaseModule } from './database';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { LoggingModule } from './logging';
import { RedisModule } from './redis';

@Module({
  imports: [ConfigModule, LoggingModule, DatabaseModule, RedisModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class PlatformModule {}
