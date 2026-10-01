import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { Actor } from '../identity/identity.service.js';

/**
 * Запрос API после общей проверки личности. Контроллеры получают подтверждённого
 * участника из guard, а не доверяют полям тела или заголовкам с именем автора.
 */
export interface AuthenticatedRequest extends Request {
  actor: Actor;
}

export function actorOf(request: AuthenticatedRequest): Actor {
  return request.actor;
}

export function requireAdmin(actor: Actor): asserts actor is Actor & { kind: 'human' } {
  if (actor.kind !== 'human' || !actor.admin) throw new ForbiddenException('Требуется глобальная роль admin');
}

export function validId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException('Неверный идентификатор');
  }
  return value.toLowerCase();
}
