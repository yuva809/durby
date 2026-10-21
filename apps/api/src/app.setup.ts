import type { INestApplication } from '@nestjs/common';
import { Logger } from 'nestjs-pino';

export const API_PREFIX = 'api/v1';

/** Shared by main.ts and e2e tests so both run the same HTTP setup. */
export function configureApp(app: INestApplication): INestApplication {
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
  return app;
}
