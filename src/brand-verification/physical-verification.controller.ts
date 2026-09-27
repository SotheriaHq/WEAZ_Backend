import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PhysicalVerificationStatus, Role } from '@prisma/client';
import type { Request } from 'express';

import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { RolesGuard } from '../auth/guard/role.guard';
import { Roles } from '../auth/decorator/roles.decorator';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { RequirePermissions } from '../admin/decorators/require-permissions.decorator';
import { ADMIN_PERMISSIONS } from '../admin/constants/permissions';
import { PhysicalVerificationService } from './physical-verification.service';
import {
  AddPhysicalVerificationProofDto,
  AssignPhysicalVerificationDto,
  BrandVisitReplyDto,
  DecidePhysicalVerificationDto,
  ProposeVisitDto,
  RescheduleResponseDto,
} from './dto/physical-verification.dto';

type AuthedRequest = Request & { user?: { id?: string } };

const actorId = (req: AuthedRequest): string => String(req.user?.id ?? '');

/**
 * The verification agent's console.
 *
 * Every route here is behind its own permission rather than a blanket
 * "brands.verify", so an account can hold exactly these and nothing else: a
 * verification AGENT who visits workspaces and records what they found, with
 * no power to approve documents, suspend a brand, or read the rest of the
 * brand console. Granting both sets is still possible and is how a reviewer
 * who also does visits is set up.
 */
@ApiTags('verification/physical')
@ApiBearerAuth()
@Controller('verification/physical')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class PhysicalVerificationAdminController {
  constructor(private readonly service: PhysicalVerificationService) {}

  @Get()
  @RequirePermissions(ADMIN_PERMISSIONS.VERIFICATION_PHYSICAL_READ)
  @ApiOperation({ summary: 'The visit queue, and an agent’s own workload' })
  async list(
    @Query('status') status?: PhysicalVerificationStatus,
    @Query('assignedAgentId') assignedAgentId?: string,
    @Query('mine') mine?: string,
    @Req() req?: AuthedRequest,
  ) {
    return this.service.listQueue({
      status,
      assignedAgentId:
        mine === 'true' ? actorId(req as AuthedRequest) : assignedAgentId,
    });
  }

  @Get(':id')
  @RequirePermissions(ADMIN_PERMISSIONS.VERIFICATION_PHYSICAL_READ)
  async detail(@Param('id') id: string) {
    return this.service.getDetail(id);
  }

  /** Handing someone else the visit — SuperAdmin only, by permission. */
  @Post(':id/assign')
  @RequirePermissions(ADMIN_PERMISSIONS.VERIFICATION_PHYSICAL_ASSIGN)
  @ApiOperation({ summary: 'Assign a visit to an agent' })
  async assign(
    @Param('id') id: string,
    @Body() dto: AssignPhysicalVerificationDto,
    @Req() req: AuthedRequest,
  ) {
    return this.service.assign(id, dto.agentId, actorId(req));
  }

  /** Taking an unowned visit off the queue yourself. */
  @Post(':id/claim')
  @RequirePermissions(ADMIN_PERMISSIONS.VERIFICATION_PHYSICAL_CLAIM)
  @ApiOperation({ summary: 'Claim an unassigned visit' })
  async claim(@Param('id') id: string, @Req() req: Request) {
    return this.service.claim(id, actorId(req));
  }

  @Post(':id/propose')
  @RequirePermissions(ADMIN_PERMISSIONS.VERIFICATION_PHYSICAL_SCHEDULE)
  @ApiOperation({ summary: 'Offer the brand times for the visit' })
  async propose(
    @Param('id') id: string,
    @Body() dto: ProposeVisitDto,
    @Req() req: AuthedRequest,
  ) {
    return this.service.proposeVisit(id, actorId(req), {
      slots: dto.slots,
      note: dto.note,
    });
  }

  @Post(':id/reschedule-response')
  @RequirePermissions(ADMIN_PERMISSIONS.VERIFICATION_PHYSICAL_SCHEDULE)
  @ApiOperation({
    summary: 'Answer a reschedule request: accept it, or postpone with no date',
  })
  async respondToReschedule(
    @Param('id') id: string,
    @Body() dto: RescheduleResponseDto,
    @Req() req: AuthedRequest,
  ) {
    return this.service.respondToReschedule(id, actorId(req), {
      decision: dto.decision,
      note: dto.note,
    });
  }

  @Post(':id/proofs')
  @RequirePermissions(ADMIN_PERMISSIONS.VERIFICATION_PHYSICAL_DECIDE)
  @ApiOperation({ summary: 'Attach evidence from the visit' })
  async addProof(
    @Param('id') id: string,
    @Body() dto: AddPhysicalVerificationProofDto,
    @Req() req: AuthedRequest,
  ) {
    return this.service.addProof(id, actorId(req), dto);
  }

  @Delete(':id/proofs/:proofId')
  @RequirePermissions(ADMIN_PERMISSIONS.VERIFICATION_PHYSICAL_DECIDE)
  async removeProof(
    @Param('id') id: string,
    @Param('proofId') proofId: string,
    @Req() req: AuthedRequest,
  ) {
    return this.service.removeProof(id, proofId, actorId(req));
  }

  @Post(':id/decision')
  @RequirePermissions(ADMIN_PERMISSIONS.VERIFICATION_PHYSICAL_DECIDE)
  @ApiOperation({ summary: 'Record the verdict (evidence floor enforced)' })
  async decide(
    @Param('id') id: string,
    @Body() dto: DecidePhysicalVerificationDto,
    @Req() req: AuthedRequest,
  ) {
    return this.service.decide(id, actorId(req), dto);
  }
}

/**
 * The brand's side: see the request, and answer it.
 *
 * The answer is three choices and nothing else — agree to one of the offered
 * times, ask for a different one of them, or decline. That constraint is
 * enforced HERE rather than in the UI, because a scheduling negotiation that
 * accepts arbitrary input is one an agent cannot plan a day around.
 */
@ApiTags('verification/physical')
@ApiBearerAuth()
@Controller('brand/verification/physical')
@UseGuards(JwtAuthGuard)
export class PhysicalVerificationBrandController {
  constructor(private readonly service: PhysicalVerificationService) {}

  @Get()
  @ApiOperation({ summary: 'This brand’s visit, if one is open' })
  async mine(@Req() req: Request) {
    return this.service.getForBrandOwner(actorId(req));
  }

  @Post(':id/reply')
  @ApiOperation({ summary: 'Agree, ask for another offered time, or decline' })
  async reply(
    @Param('id') id: string,
    @Body() dto: BrandVisitReplyDto,
    @Req() req: AuthedRequest,
  ) {
    return this.service.submitBrandReply(actorId(req), id, {
      response: dto.response,
      selectedSlot: dto.selectedSlot,
      note: dto.note,
    });
  }
}
