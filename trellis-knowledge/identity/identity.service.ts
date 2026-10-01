import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException, BadRequestException, NotFoundException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import { Database } from '../server/db.js';

/**
 * Подтверждённая человеческая или агентская личность. Административная роль
 * берётся из проверенного OIDC-токена и никогда не заменяет проектное право.
 */
export type Actor =
  | { kind: 'human'; id: string; username: string; admin: boolean }
  | { kind: 'agent'; id: string; name: string };

/**
 * Identity связывает людей с issuer/sub, проверяет отдельные токены агентов и
 * хранит лишь хеш секрета. Пароли людей, их сессии и глобальные роли остаются
 * у OIDC-провайдера; проектные назначения здесь не вычисляются.
 */
@Injectable()
export class IdentityService {
  private readonly issuer = process.env.OIDC_ISSUER ?? 'http://localhost:8080/realms/trellis';
  private readonly audience = process.env.OIDC_AUDIENCE ?? 'trellis-api';
  private readonly jwks = createRemoteJWKSet(new URL(process.env.OIDC_JWKS_URL ?? `${this.issuer}/protocol/openid-connect/certs`));

  constructor(private readonly db: Database) {}

  async authenticate(header: string | undefined): Promise<Actor> {
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
    const token = header.slice(7);
    if (token.startsWith('trla_')) return this.authenticateAgent(token);
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, { issuer: this.issuer, audience: this.audience }));
    } catch {
      throw new UnauthorizedException('Недействительный токен');
    }
    return this.authenticateHuman(payload);
  }

  private async authenticateHuman(payload: JWTPayload): Promise<Actor> {
    if (typeof payload.sub !== 'string' || !payload.sub) throw new UnauthorizedException();
    const username = typeof payload.preferred_username === 'string' ? payload.preferred_username : payload.sub;
    const displayName = typeof payload.name === 'string' ? payload.name : username;
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO people(id, issuer, subject, username, display_name)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (issuer, subject) DO UPDATE SET username = EXCLUDED.username,
         display_name = EXCLUDED.display_name, last_seen_at = now() RETURNING id`,
      [randomUUID(), this.issuer, payload.sub, username, displayName],
    );
    const realm = payload.realm_access as { roles?: unknown } | undefined;
    const admin = Array.isArray(realm?.roles) && realm.roles.includes('trellis-admin');
    return { kind: 'human', id: result.rows[0].id, username, admin };
  }

  private async authenticateAgent(token: string): Promise<Actor> {
    const hash = createHash('sha256').update(token).digest('hex');
    const result = await this.db.query<{ id: string; name: string }>(
      `SELECT a.id, a.name FROM agent_tokens t JOIN agents a ON a.id=t.agent_id
       WHERE t.token_hash=$1 AND a.enabled=true`, [hash],
    );
    if (!result.rows[0]) throw new UnauthorizedException('Недействительный токен агента');
    return { kind: 'agent', ...result.rows[0] };
  }

  async people(): Promise<unknown[]> {
    const result = await this.db.query('SELECT id, username, display_name FROM people ORDER BY username');
    return result.rows;
  }

  async agents(): Promise<unknown[]> {
    const result = await this.db.query('SELECT id, name, enabled, created_at FROM agents ORDER BY name');
    return result.rows;
  }

  async createAgent(body: unknown): Promise<unknown> {
    const parsed = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    try {
      const result = await this.db.query('INSERT INTO agents(id,name) VALUES ($1,$2) RETURNING id,name,enabled', [randomUUID(), parsed.data.name]);
      return result.rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new BadRequestException('Агент с таким именем уже существует');
      throw error;
    }
  }

  async setAgentEnabled(id: string, body: unknown): Promise<unknown> {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const result = await this.db.query('UPDATE agents SET enabled=$2 WHERE id=$1 RETURNING id,name,enabled', [id, parsed.data.enabled]);
    if (!result.rows[0]) throw new NotFoundException('Агент не найден');
    return result.rows[0];
  }

  async issueToken(id: string): Promise<unknown> {
    const token = `trla_${randomBytes(32).toString('base64url')}`;
    const result = await this.db.query(
      `INSERT INTO agent_tokens(id,agent_id,token_hash)
       SELECT $1,id,$3 FROM agents WHERE id=$2 AND enabled=true RETURNING id,created_at`,
      [randomUUID(), id, createHash('sha256').update(token).digest('hex')],
    );
    if (!result.rows[0]) throw new NotFoundException('Активный агент не найден');
    return { ...result.rows[0], token };
  }

  async tokens(id: string): Promise<unknown[]> {
    const result = await this.db.query('SELECT id,created_at FROM agent_tokens WHERE agent_id=$1 ORDER BY created_at DESC', [id]);
    return result.rows;
  }

  async revokeToken(agentId: string, tokenId: string): Promise<void> {
    const result = await this.db.query('DELETE FROM agent_tokens WHERE id=$1 AND agent_id=$2', [tokenId, agentId]);
    if (!result.rowCount) throw new NotFoundException('Токен не найден');
  }
}
