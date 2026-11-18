import { Global, Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { ACTIVE_ACCESS_LOOKUP } from '../auth';
import { ACTIVE_ENTITLEMENTS_LOOKUP } from '../config/entitlements';
import { AccessGuard } from './access.guard';
import { AccessService } from './access.service';
import { ActiveAccessProvider } from './active-access.provider';
import { InvitationMailer } from './invitation-mailer';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { MemberNames } from './member-names';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { defaultPermissionRegistry, PERMISSION_REGISTRY } from './permission-registry';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
import { RouteMarkerCheck } from './route-marker.check';
import { SystemRoles } from './system-roles';
import { InvitationLinkController, TeamController } from './team.controller';
import { TeamService } from './team.service';
import { PermissionSplitReport } from './permission-split';

/** Roles, permissions and route access (docs/platform/rbac.md). AccessGuard runs on every route. */
@Global()
@Module({
  imports: [DiscoveryModule],
  controllers: [
    InvitationsController,
    InvitationLinkController,
    MembersController,
    RolesController,
    TeamController,
  ],
  providers: [
    AccessService,
    InvitationMailer,
    InvitationsService,
    MemberNames,
    MembersService,
    PermissionSplitReport,
    RolesService,
    RouteMarkerCheck,
    SystemRoles,
    TeamService,
    { provide: PERMISSION_REGISTRY, useValue: defaultPermissionRegistry },
    ActiveAccessProvider,
    { provide: ACTIVE_ACCESS_LOOKUP, useExisting: ActiveAccessProvider },
    { provide: ACTIVE_ENTITLEMENTS_LOOKUP, useExisting: ActiveAccessProvider },
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [
    ACTIVE_ACCESS_LOOKUP,
    ACTIVE_ENTITLEMENTS_LOOKUP,
    AccessService,
    MemberNames,
    PERMISSION_REGISTRY,
    SystemRoles,
  ],
})
export class RbacModule {}
