import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';

/**
 * Runs a one-off command inside the api's application context (no HTTP server), with the same
 * config and env loading as main.ts. Sets the exit code; prints only the command's own output.
 */
export async function runCommand(
  name: string,
  fn: (app: INestApplicationContext) => Promise<void>,
): Promise<void> {
  const envFile = join(__dirname, '..', '..', '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  let app: INestApplicationContext | undefined;
  try {
    app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    await fn(app);
  } catch (error) {
    // Message only: our errors carry no secrets, and stacks are noise for operators.
    console.error(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await app?.close();
  }
}
