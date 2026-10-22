import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from './platform/config';

export const API_PREFIX = 'api/v1';

/** Shared by main.ts and e2e tests so both run the same HTTP setup. */
export function configureApp(app: INestApplication): INestApplication {
  const config = app.get<AppConfig>(APP_CONFIG);
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX);
  // Client IP for rate limits comes from X-Forwarded-For only across this many trusted proxies.
  (app as NestExpressApplication).set('trust proxy', config.TRUST_PROXY);
  // Refresh token cookie (platform/auth). Unsigned: the token itself is the secret.
  app.use(cookieParser());
  app.enableShutdownHooks();
  return app;
}
