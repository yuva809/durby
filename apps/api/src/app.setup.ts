import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';
import { CATEGORY_IMAGE_MAX_BYTES, CATEGORY_IMAGE_TYPES } from '@durby/shared';
import { APP_CONFIG, type AppConfig, configWarnings } from './platform/config';
import { API_PREFIX } from './platform/http';

export { API_PREFIX };

/** Shared by main.ts and e2e tests so both run the same HTTP setup. */
export function configureApp(app: INestApplication): INestApplication {
  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = app.get(Logger);
  app.useLogger(logger);
  for (const warning of configWarnings(config)) logger.warn(warning, 'Config');
  app.setGlobalPrefix(API_PREFIX);
  // Client IP for rate limits comes from X-Forwarded-For only across this many trusted proxies.
  (app as NestExpressApplication).set('trust proxy', config.TRUST_PROXY);
  // Tile images (ADR 0048) are sent as their raw bytes: only these types, at most 300 KB. JSON keeps its default limit.
  (app as NestExpressApplication).useBodyParser('raw', {
    type: [...CATEGORY_IMAGE_TYPES],
    limit: CATEGORY_IMAGE_MAX_BYTES,
  });
  // Refresh token cookie (platform/auth). Unsigned: the token itself is the secret.
  app.use(cookieParser());
  app.enableShutdownHooks();
  return app;
}
