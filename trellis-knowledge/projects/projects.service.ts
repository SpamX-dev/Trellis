import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { Database } from '../server/db.js';
import type { Actor } from '../identity/identity.service.js';
import { validId } from '../server/http.js';
import { RepositoriesService } from '../repositories/repositories.service.js';

/**
 * Публичные метаданные проекта. Физическое расположение Git не входит в ответ,
 * а `owner_person_id` указывает на устойчивую запись подтверждённого человека.
 */
export interface Project {
  id: string;
  name: string;
  description: string;
  owner_person_id: string;
  state: 'provisioning' | 'failed' | 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

/**
 * Projects владеет проектным каталогом и проверкой полномочий. Создание Git
 * согласуется как повторяемая операция с явными промежуточными состояниями;
 * доступ к документам не следует из глобальной роли администратора.
 */
@Injectable()
export class ProjectsService {
  constructor(private readonly db: Database, private readonly repositories: RepositoriesService) {}

  async list(actor: Actor): Promise<Project[]> {
    if (actor.kind === 'human' && actor.admin) {
      return (await this.db.query<Project>('SELECT * FROM projects ORDER BY created_at DESC')).rows;
    }
    const sql = actor.kind === 'human'
      ? `SELECT DISTINCT p.* FROM projects p LEFT JOIN project_users u ON u.project_id=p.id
         WHERE p.state IN ('active','archived') AND (p.owner_person_id=$1 OR u.person_id=$1) ORDER BY p.created_at DESC`
      : `SELECT p.* FROM projects p JOIN project_agents a ON a.project_id=p.id
         WHERE p.state IN ('active','archived') AND a.agent_id=$1 ORDER BY p.created_at DESC`;
    return (await this.db.query<Project>(sql, [actor.id])).rows;
  }

  async get(id: string, actor: Actor): Promise<Project> {
    const result = await this.db.query<Project>('SELECT * FROM projects WHERE id=$1', [validId(id)]);
    const project = result.rows[0];
    if (!project || (!(actor.kind === 'human' && actor.admin) && !['active', 'archived'].includes(project.state))) throw new NotFoundException('Проект не найден');
    if (actor.kind === 'human' && actor.admin) return project;
    await this.assertRead(actor, id);
    return project;
  }

  async create(body: unknown): Promise<Project> {
    const parsed = z.object({
      name: z.string().trim().min(1).max(160),
      description: z.string().max(4000).default(''),
      ownerPersonId: z.string().uuid(),
    }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await this.assertPerson(parsed.data.ownerPersonId);
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO projects(id,name,description,owner_person_id,state) VALUES ($1,$2,$3,$4,'provisioning')`,
      [id, parsed.data.name, parsed.data.description, parsed.data.ownerPersonId],
    );
    return this.provision(id);
  }

  async retry(id: string): Promise<Project> {
    const project = await this.internalGet(validId(id));
    if (project.state === 'active') return project;
    if (project.state === 'archived') throw new ConflictException('Архивный проект нельзя создавать повторно');
    return this.provision(project.id);
  }

  private async provision(id: string): Promise<Project> {
    try {
      await this.repositories.ensure(id);
      const result = await this.db.query<Project>(
        `UPDATE projects SET state='active', updated_at=now()
         WHERE id=$1 AND state IN ('provisioning','failed') RETURNING *`, [id],
      );
      if (!result.rows[0]) throw new ConflictException('Состояние проекта изменилось');
      return result.rows[0];
    } catch (error) {
      await this.db.query("UPDATE projects SET state='failed', updated_at=now() WHERE id=$1 AND state='provisioning'", [id]);
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException({ message: 'Не удалось подготовить Git-репозиторий', projectId: id });
    }
  }

  private async internalGet(id: string): Promise<Project> {
    const result = await this.db.query<Project>('SELECT * FROM projects WHERE id=$1', [id]);
    if (!result.rows[0]) throw new NotFoundException('Проект не найден');
    return result.rows[0];
  }

  private async assertPerson(id: string): Promise<void> {
    const result = await this.db.query('SELECT 1 FROM people WHERE id=$1', [validId(id)]);
    if (!result.rowCount) throw new BadRequestException('Владелец должен сначала войти в Trellis');
  }

  async update(id: string, body: unknown): Promise<Project> {
    const parsed = z.object({
      name: z.string().trim().min(1).max(160).optional(),
      description: z.string().max(4000).optional(),
      ownerPersonId: z.string().uuid().optional(),
    }).strict().refine((value) => Object.keys(value).length > 0).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    if (parsed.data.ownerPersonId) await this.assertPerson(parsed.data.ownerPersonId);
    const projectId = validId(id);
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<Project>(
        `UPDATE projects SET name=COALESCE($2,name), description=COALESCE($3,description),
           owner_person_id=COALESCE($4,owner_person_id), updated_at=now()
         WHERE id=$1 AND state IN ('active','archived') RETURNING *`,
        [projectId, parsed.data.name ?? null, parsed.data.description ?? null, parsed.data.ownerPersonId ?? null],
      );
      if (!result.rows[0]) throw new NotFoundException('Проект не найден');
      if (parsed.data.ownerPersonId) {
        await client.query('DELETE FROM project_users WHERE project_id=$1 AND person_id=$2', [projectId, parsed.data.ownerPersonId]);
      }
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async archive(id: string): Promise<Project> {
    const result = await this.db.query<Project>(
      "UPDATE projects SET state='archived', updated_at=now() WHERE id=$1 AND state IN ('active','archived') RETURNING *", [validId(id)],
    );
    if (!result.rows[0]) throw new NotFoundException('Проект не найден');
    return result.rows[0];
  }

  async assertRead(actor: Actor, id: string): Promise<Project> {
    const project = await this.internalGet(validId(id));
    if (!['active', 'archived'].includes(project.state)) throw new NotFoundException('Проект не готов');
    if (actor.kind === 'human') {
      if (project.owner_person_id === actor.id) return project;
      const result = await this.db.query('SELECT 1 FROM project_users WHERE project_id=$1 AND person_id=$2', [id, actor.id]);
      if (result.rowCount) return project;
    } else {
      const result = await this.db.query('SELECT 1 FROM project_agents WHERE project_id=$1 AND agent_id=$2', [id, actor.id]);
      if (result.rowCount) return project;
    }
    throw new ForbiddenException('Нет доступа к содержимому проекта');
  }

  async assertOwner(actor: Actor, id: string): Promise<Project> {
    if (actor.kind !== 'human') throw new ForbiddenException('Требуется владелец проекта');
    const project = await this.assertRead(actor, id);
    if (project.owner_person_id !== actor.id) throw new ForbiddenException('Требуется владелец проекта');
    return project;
  }

  async assertCanChooseParticipants(actor: Actor): Promise<void> {
    if (actor.kind !== 'human') throw new ForbiddenException();
    if (actor.admin) return;
    const result = await this.db.query('SELECT 1 FROM projects WHERE owner_person_id=$1 AND state IN (\'active\',\'archived\') LIMIT 1', [actor.id]);
    if (!result.rowCount) throw new ForbiddenException('Требуется владелец проекта');
  }

  async users(id: string): Promise<unknown[]> {
    const result = await this.db.query(
      `SELECT p.id,p.username,p.display_name FROM project_users u JOIN people p ON p.id=u.person_id
       WHERE u.project_id=$1 ORDER BY p.username`, [id],
    );
    return result.rows;
  }

  async addUser(id: string, personId: string): Promise<void> {
    const project = await this.internalGet(validId(id));
    await this.assertPerson(personId);
    if (project.owner_person_id === personId) throw new BadRequestException('Владелец уже имеет доступ');
    await this.db.query('INSERT INTO project_users(project_id,person_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, personId]);
  }

  async removeUser(id: string, personId: string): Promise<void> {
    await this.db.query('DELETE FROM project_users WHERE project_id=$1 AND person_id=$2', [id, validId(personId)]);
  }

  async agents(id: string): Promise<unknown[]> {
    const result = await this.db.query(
      `SELECT a.id,a.name,a.enabled FROM project_agents g JOIN agents a ON a.id=g.agent_id
       WHERE g.project_id=$1 ORDER BY a.name`, [id],
    );
    return result.rows;
  }

  async addAgent(id: string, agentId: string): Promise<void> {
    const result = await this.db.query('SELECT 1 FROM agents WHERE id=$1 AND enabled=true', [validId(agentId)]);
    if (!result.rowCount) throw new BadRequestException('Активный агент не найден');
    await this.db.query('INSERT INTO project_agents(project_id,agent_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, agentId]);
  }

  async removeAgent(id: string, agentId: string): Promise<void> {
    await this.db.query('DELETE FROM project_agents WHERE project_id=$1 AND agent_id=$2', [id, validId(agentId)]);
  }
}
