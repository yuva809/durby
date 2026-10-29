import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  type CustomerDetail,
  type CustomerListQuery,
  customerListQuerySchema,
  type CustomerListResponse,
  IDEMPOTENCY_KEY_HEADER,
  type OnboardCustomerBody,
  onboardCustomerRequestSchema,
  type OnboardingOptionsResponse,
} from '@durby/shared';
import { ZodBody, ZodQuery } from '../http';
import { idempotencyErrors } from '../idempotency';
import { IdempotencyExempt, PlatformOnly } from '../markers';
import { CustomersService } from './customers.service';
import { StaffContext } from './staff-context';
import { staffErrors } from './staff-errors';

/** Same contract as the tenant store (ADR 0014): 1–255 visible ASCII characters. */
const KEY_FORMAT = /^[\x21-\x7e]{1,255}$/;
const idPipe = new ParseUUIDPipe({ exceptionFactory: staffErrors.customerNotFound });

/** /api/v1/platform/customers (docs/platform/admin-portal.md → Customers, Onboarding). */
@Controller('platform/customers')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly context: StaffContext,
  ) {}

  @PlatformOnly('staff.customers.read')
  @Get()
  async list(
    @Query(new ZodQuery(customerListQuerySchema)) query: CustomerListQuery,
  ): Promise<CustomerListResponse> {
    return { data: await this.customers.list(query.query || undefined) };
  }

  /**
   * Appends a whole customer, so it needs an Idempotency-Key; the staff store replays it in the
   * business transaction (ADR 0017 §8, amended), not the tenant interceptor.
   */
  @PlatformOnly('staff.customers.create', { fresh: true })
  @IdempotencyExempt('staff write: replayed through staff_idempotency_keys (ADR 0017 §8)')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  onboard(
    @Headers(IDEMPOTENCY_KEY_HEADER.toLowerCase()) key: string | undefined,
    @Body(new ZodBody(onboardCustomerRequestSchema)) body: OnboardCustomerBody,
  ): Promise<CustomerDetail> {
    if (key === undefined || key === '') throw idempotencyErrors.keyRequired();
    if (!KEY_FORMAT.test(key)) throw idempotencyErrors.keyInvalid();
    return this.customers.onboard(this.context.require().staffId, key, body);
  }

  @PlatformOnly('staff.customers.read')
  @Get(':id')
  detail(@Param('id', idPipe) id: string): Promise<CustomerDetail> {
    return this.customers.detail(id);
  }

  /** Naturally replay-safe: each call only sends a fresh link while the Owner has no password. */
  @PlatformOnly('staff.customers.invite', { fresh: true })
  @IdempotencyExempt('staff write: sends a new link, changes no data (ADR 0017 §8)')
  @Post(':id/owner-invite')
  @HttpCode(HttpStatus.OK)
  resendOwnerInvite(@Param('id', idPipe) id: string): Promise<CustomerDetail> {
    return this.customers.resendOwnerInvite(this.context.require().staffId, id);
  }
}

/** /api/v1/platform/onboarding-options: what the onboarding form offers. */
@Controller('platform/onboarding-options')
export class OnboardingOptionsController {
  constructor(private readonly customers: CustomersService) {}

  @PlatformOnly('staff.customers.create')
  @Get()
  options(): Promise<OnboardingOptionsResponse> {
    return this.customers.options();
  }
}
