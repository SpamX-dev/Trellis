import { CanActivate, Controller, ExecutionContext, Get, Injectable, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { AuthenticatedRequest } from './http.js';
import { Database } from './db.js';
import { IdentityService } from '../identity/identity.service.js';
import { IdentityController } from '../identity/identity.controller.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ProjectsController } from '../projects/projects.controller.js';
import { RepositoriesService } from '../repositories/repositories.service.js';
import { RepositoriesController } from '../repositories/repositories.controller.js';

/**
 * Общий guard подтверждает личность для всех API-операций. Исключение здоровья
 * не раскрывает проектные данные; остальные методы получают Actor в запросе.
 */
@Injectable()
export class IdentityGuard implements CanActivate {
  constructor(private readonly identity: IdentityService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.path === '/api/health') return true;
    request.actor = await this.identity.authenticate(request.headers.authorization);
    return true;
  }
}

/**
 * Служебная проверка готовности API. Её публичный ответ не подтверждает
 * проектное право и не содержит сведений о репозиториях или пользователях.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly db: Database) {}

  @Get() async health() {
    await this.db.query('SELECT 1');
    return { ok: true };
  }
}

/**
 * Композиционный корень Knowledge. Доменный код остаётся в каталогах Identity,
 * Projects и Repositories; контроллеры не владеют базой или Git напрямую.
 */
@Module({
  controllers: [HealthController, IdentityController, ProjectsController, RepositoriesController],
  providers: [Database, IdentityService, ProjectsService, RepositoriesService, { provide: APP_GUARD, useClass: IdentityGuard }],
})
export class AppModule {}
