import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { ProjectsService } from './projects.service.js';
import { actorOf, requireAdmin, validId, type AuthenticatedRequest } from '../server/http.js';

/**
 * REST-вход для каталога и назначений Projects. Каждый метод проверяет право
 * перед вызовом изменения; глобальный администратор не получает неявное право
 * управлять содержимым или участниками без роли владельца.
 */
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get() list(@Req() request: AuthenticatedRequest) { return this.projects.list(actorOf(request)); }

  @Get(':id') get(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.projects.get(validId(id), actorOf(request));
  }

  @Post() create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    requireAdmin(actorOf(request));
    return this.projects.create(body);
  }

  @Patch(':id') update(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown) {
    requireAdmin(actorOf(request));
    return this.projects.update(validId(id), body);
  }

  @Post(':id/archive') archive(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    requireAdmin(actorOf(request));
    return this.projects.archive(validId(id));
  }

  @Post(':id/retry') retry(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    requireAdmin(actorOf(request));
    return this.projects.retry(validId(id));
  }

  @Get(':id/users') async users(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    await this.projects.assertOwner(actorOf(request), validId(id));
    return this.projects.users(id);
  }

  @Put(':id/users/:personId') async addUser(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Param('personId') personId: string) {
    await this.projects.assertOwner(actorOf(request), validId(id));
    await this.projects.addUser(id, validId(personId));
    return { assigned: true };
  }

  @Delete(':id/users/:personId') async removeUser(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Param('personId') personId: string) {
    await this.projects.assertOwner(actorOf(request), validId(id));
    await this.projects.removeUser(id, validId(personId));
    return { removed: true };
  }

  @Get(':id/agents') async agents(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    await this.projects.assertOwner(actorOf(request), validId(id));
    return this.projects.agents(id);
  }

  @Put(':id/agents/:agentId') async addAgent(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Param('agentId') agentId: string) {
    await this.projects.assertOwner(actorOf(request), validId(id));
    await this.projects.addAgent(id, validId(agentId));
    return { assigned: true };
  }

  @Delete(':id/agents/:agentId') async removeAgent(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Param('agentId') agentId: string) {
    await this.projects.assertOwner(actorOf(request), validId(id));
    await this.projects.removeAgent(id, validId(agentId));
    return { removed: true };
  }
}
