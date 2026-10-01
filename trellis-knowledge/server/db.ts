import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';

/**
 * Единственная граница подключения к базе Knowledge. Сервис не обращается к базе
 * Keycloak и выдаёт доменным модулям соединения только для их собственных таблиц.
 * Миграции выполняются при старте под межпроцессной блокировкой PostgreSQL.
 */
@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool = new pg.Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {});

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<T>> {
    return this.pool.query<T>(sql, params);
  }

  async migrate(): Promise<void> {
    const directory = resolve(process.env.MIGRATIONS_DIR ?? 'trellis-knowledge/server/migrations');
    const filenames = (await readdir(directory)).filter((name) => /^\d+_[\w-]+\.sql$/.test(name)).sort();
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(8432156201)');
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL)');
      for (const filename of filenames) {
        const sql = await readFile(resolve(directory, filename), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const existing = await client.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name = $1', [filename]);
        if (existing.rows[0]) {
          if (existing.rows[0].checksum !== checksum) throw new Error(`Изменена применённая миграция ${filename}`);
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [filename, checksum]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(8432156201)');
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
