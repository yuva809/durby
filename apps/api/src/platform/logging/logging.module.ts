import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config';
import { buildPinoHttpOptions } from './logger.options';

/** Structured JSON logs (pino) with one request id per request; see logger.options.ts. */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ pinoHttp: buildPinoHttpOptions(config) }),
    }),
  ],
})
export class LoggingModule {}
