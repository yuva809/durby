import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import {
  findIdempotencyMarkerProblems,
  IdempotencyMarkerError,
  listIdempotencyRoutes,
} from './idempotency-markers';

/** Refuses to boot unless every write route is @Idempotent() or exempt (CLAUDE.md rule 8). */
@Injectable()
export class IdempotencyMarkerCheck implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const routes = listIdempotencyRoutes(this.discovery, this.scanner, this.reflector);
    const problems = findIdempotencyMarkerProblems(routes);
    if (problems.length > 0) throw new IdempotencyMarkerError(problems);
  }
}
