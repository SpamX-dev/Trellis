import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { IdentityService } from './identity.service.js';
import { actorOf, requireAdmin, validId, type AuthenticatedRequest } from '../server/http.js';
import { ProjectsService } from '../projects/projects.service.js';

/**
 * HTTP-представление Identity. Выдача агентского секрета доступна только
 * глобальному администратору; owner видит имена агентов для проектного назначения.
 */
@Controller()
export class IdentityController {
  constructor(private readonly identity: IdentityService, private readonly projects: ProjectsService) {}

  @Get('me') me(@Req() request: AuthenticatedRequest) { return actorOf(request); }

  @Get('people') async people(@Req() request: AuthenticatedRequest) {
    await this.projects.assertCanChooseParticipants(actorOf(request));
    return this.identity.people();
  }

  @Get('agents') async agents(@Req() request: AuthenticatedRequest) {
    await this.projects.assertCanChooseParticipants(actorOf(request));
    return this.identity.agents();
  }

  @Post('agents') create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    requireAdmin(actorOf(request));
    return this.identity.createAgent(body);
  }

  @Patch('agents/:id') update(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown) {
    requireAdmin(actorOf(request));
    return this.identity.setAgentEnabled(validId(id), body);
  }

  @Get('agents/:id/tokens') tokens(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    requireAdmin(actorOf(request));
    return this.identity.tokens(validId(id));
  }

  @Post('agents/:id/tokens') issue(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    requireAdmin(actorOf(request));
    return this.identity.issueToken(validId(id));
  }

  @Delete('agents/:id/tokens/:tokenId') async revoke(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Param('tokenId') tokenId: string) {
    requireAdmin(actorOf(request));
    await this.identity.revokeToken(validId(id), validId(tokenId));
    return { revoked: true };
  }
}
