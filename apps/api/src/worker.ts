import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { OutboxWorker } from './platform/outbox';

// Local dev convenience: real deployments inject env vars directly.
const envFile = join(__dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

/**
 * The outbox worker process (docs/platform/outbox.md → Worker process, ADR 0013 §9): same image
 * and modules as the api, no HTTP server. Publishes committed events and runs their handlers.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.get(OutboxWorker).start();
}

void bootstrap();
