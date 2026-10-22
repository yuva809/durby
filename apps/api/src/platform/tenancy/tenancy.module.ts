import { Global, Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { PrismaService } from '../database';
import {
  createPlatformPrismaClient,
  createTenantPrismaClient,
  PLATFORM_PRISMA,
  TENANT_PRISMA,
} from './prisma-clients';
import { TenantContext } from './tenant-context';

@Global()
@Module({
  // One CLS scope per HTTP request; the auth guard (step 1.2) puts the tenant into it.
  imports: [ClsModule.forRoot({ global: true, middleware: { mount: true } })],
  providers: [
    TenantContext,
    {
      provide: TENANT_PRISMA,
      inject: [PrismaService, TenantContext],
      useFactory: createTenantPrismaClient,
    },
    {
      provide: PLATFORM_PRISMA,
      inject: [PrismaService],
      useFactory: createPlatformPrismaClient,
    },
  ],
  exports: [TenantContext, TENANT_PRISMA, PLATFORM_PRISMA],
})
export class TenancyModule {}
