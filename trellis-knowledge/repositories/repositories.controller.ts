import { BadRequestException, Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ProjectsService } from '../projects/projects.service.js';
import { actorOf, validId, type AuthenticatedRequest } from '../server/http.js';
import { RepositoriesService } from './repositories.service.js';

/**
 * HTTP-чтение Git после проверки Projects. Контроллер не выдаёт адреса bare
 * хранилища и принимает для исторических файлов только точные коммиты main.
 */
@Controller('projects/:id')
export class RepositoriesController {
  constructor(private readonly projects: ProjectsService, private readonly repositories: RepositoriesService) {}

  private async authorize(request: AuthenticatedRequest, id: string): Promise<string> {
    const projectId = validId(id);
    await this.projects.assertRead(actorOf(request), projectId);
    return projectId;
  }

  @Get('repository') async repository(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    const projectId = await this.authorize(request, id);
    return { projectId, main: await this.repositories.head(projectId) };
  }

  @Get('commits') async commits(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Query('skip') rawSkip?: string) {
    const projectId = await this.authorize(request, id);
    if (rawSkip !== undefined && !/^\d+$/.test(rawSkip)) throw new BadRequestException('Неверная страница');
    return this.repositories.history(projectId, rawSkip === undefined ? 0 : Number(rawSkip));
  }

  @Get('commits/:oid/tree') async tree(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Param('oid') oid: string, @Query('path') path?: string) {
    const projectId = await this.authorize(request, id);
    return this.repositories.tree(projectId, oid, path ?? '');
  }

  @Get('commits/:oid/blob') async blob(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Param('oid') oid: string, @Query('path') path?: string) {
    const projectId = await this.authorize(request, id);
    return this.repositories.blob(projectId, oid, path ?? '');
  }
}
