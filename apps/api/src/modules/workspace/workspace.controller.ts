import { Controller, Get, Query } from '@nestjs/common';
import {
  type AttentionResponse,
  type SearchQuery,
  searchQuerySchema,
  type SearchResult,
} from '@durby/shared';
import { Authenticated } from '../../platform/auth';
import { ZodQuery } from '../../platform/http';
import { WorkspaceService } from './workspace.service';

/**
 * /api/v1/search and /api/v1/attention (ADR 0046): the top bar for every signed-in member. @Authenticated(): each
 * module answers only what the caller's keys and locations allow, and nothing for modules the organization lacks.
 */
@Controller()
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Authenticated()
  @Get('search')
  async search(
    @Query(new ZodQuery(searchQuerySchema)) query: SearchQuery,
  ): Promise<{ data: SearchResult[] }> {
    return { data: await this.workspace.search(query.q) };
  }

  @Authenticated()
  @Get('attention')
  attention(): Promise<AttentionResponse> {
    return this.workspace.attention();
  }
}
