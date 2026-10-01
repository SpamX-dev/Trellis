import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { Database } from '../../dist/trellis-knowledge/server/db.js';
import { AppModule } from '../../dist/trellis-knowledge/server/app.js';
import { ProjectsService } from '../../dist/trellis-knowledge/projects/projects.service.js';
import { RepositoriesService } from '../../dist/trellis-knowledge/repositories/repositories.service.js';
import { IdentityService } from '../../dist/trellis-knowledge/identity/identity.service.js';

// Интеграционный тест использует отдельную базу и временные bare Git-репозитории.
// Он проверяет настоящие SQL, Git и HTTP; OIDC-вход проверяется браузерным сценарием.
test('Projects, Repositories и агентский HTTP-доступ', async () => {
  if (!process.env.DATABASE_URL?.includes('knowledge_stage1_test_') && !process.env.PGDATABASE?.startsWith('knowledge_stage1_test_')) throw new Error('Требуется отдельная тестовая база');
  const temp = await mkdtemp(join(tmpdir(), 'trellis-stage1-'));
  const db = new Database();
  let app;
  try {
    await db.migrate();
    const [ownerId, userId, adminId] = [randomUUID(), randomUUID(), randomUUID()];
    for (const [id, username] of [[ownerId, 'owner'], [userId, 'user'], [adminId, 'admin']]) {
      await db.query('INSERT INTO people(id,issuer,subject,username,display_name) VALUES ($1,$2,$3,$4,$4)', [id, 'http://test', id, username]);
    }
    process.env.GIT_ROOT = join(temp, 'repositories');
    const repositories = new RepositoriesService();
    const projects = new ProjectsService(db, repositories);
    const identity = new IdentityService(db);
    const owner = { kind: 'human', id: ownerId, username: 'owner', admin: false };
    const user = { kind: 'human', id: userId, username: 'user', admin: false };
    const admin = { kind: 'human', id: adminId, username: 'admin', admin: true };

    const project = await projects.create({ name: 'Integration', ownerPersonId: ownerId });
    assert.equal(project.state, 'active');
    const first = await repositories.head(project.id);
    assert.match(first, /^[0-9a-f]{40}$/);
    assert.deepEqual(await repositories.tree(project.id, first, ''), []);
    assert.equal((await projects.get(project.id, admin)).id, project.id);
    await assert.rejects(projects.assertRead(admin, project.id), { status: 403 });
    await assert.rejects(projects.assertRead(user, project.id), { status: 403 });
    await projects.assertRead(owner, project.id);
    await projects.addUser(project.id, userId);
    await projects.assertRead(user, project.id);

    const agent = await identity.createAgent({ name: 'integration-agent' });
    const secret = await identity.issueToken(agent.id);
    const agentActor = await identity.authenticate(`Bearer ${secret.token}`);
    await assert.rejects(projects.assertRead(agentActor, project.id), { status: 403 });
    await projects.addAgent(project.id, agent.id);
    await projects.assertRead(agentActor, project.id);

    const work = join(temp, 'working');
    execFileSync('git', ['clone', join(process.env.GIT_ROOT, `${project.id}.git`), work]);
    execFileSync('git', ['-C', work, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', work, 'config', 'user.email', 'test@local']);
    await writeFile(join(work, 'hello.txt'), 'hello from commit\n');
    await symlink('../outside-secret', join(work, 'link'));
    execFileSync('git', ['-C', work, 'add', '.']);
    execFileSync('git', ['-C', work, 'commit', '-m', 'Committed files']);
    execFileSync('git', ['-C', work, 'push', 'origin', 'main']);
    const head = await repositories.head(project.id);
    const tree = await repositories.tree(project.id, head, '');
    assert.deepEqual(tree.map((entry) => entry.name).sort(), ['hello.txt', 'link']);
    assert.equal((await repositories.blob(project.id, head, 'hello.txt')).content, 'hello from commit\n');
    const link = await repositories.blob(project.id, head, 'link');
    assert.equal(link.mode, '120000');
    assert.equal(link.content, '../outside-secret');
    await assert.rejects(repositories.tree(project.id, head, '../outside-secret'), { status: 400 });
    await assert.rejects(repositories.exactCommit(project.id, '0'.repeat(40)), { status: 404 });
    const emptyTree = execFileSync('git', ['-C', join(process.env.GIT_ROOT, `${project.id}.git`), 'mktree'], { input: '' }).toString().trim();
    const unreachable = execFileSync('git', ['-C', join(process.env.GIT_ROOT, `${project.id}.git`), 'commit-tree', emptyTree, '-m', 'Unreachable'], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@local', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@local' },
    }).toString().trim();
    await assert.rejects(repositories.exactCommit(project.id, unreachable), { status: 404 });
    assert.equal((await repositories.history(project.id, 0)).length, 2);

    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api');
    await app.listen(3100, '127.0.0.1');
    const base = 'http://127.0.0.1:3100/api';
    const headers = { Authorization: `Bearer ${secret.token}` };
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/projects`)).status, 401);
    assert.equal((await fetch(`${base}/projects`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/projects/${project.id}/repository`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/projects`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    await identity.revokeToken(agent.id, secret.id);
    assert.equal((await fetch(`${base}/projects`, { headers })).status, 401);

    await projects.archive(project.id);
    await projects.assertRead(owner, project.id);
    await projects.assertRead(user, project.id);
    assert.equal(await repositories.head(project.id), head);
    await projects.update(project.id, { ownerPersonId: userId });
    await projects.assertOwner(user, project.id);
    await assert.rejects(projects.assertRead(owner, project.id), { status: 403 });
    assert.equal((await db.query('SELECT count(*)::int AS count FROM project_users WHERE project_id=$1 AND person_id=$2', [project.id, userId])).rows[0].count, 0);

    await writeFile(join(temp, 'blocked'), 'file');
    process.env.GIT_ROOT = join(temp, 'blocked');
    const broken = new ProjectsService(db, new RepositoriesService());
    let failedId;
    try { await broken.create({ name: 'Retry', ownerPersonId: ownerId }); }
    catch (error) { failedId = error.response?.projectId; }
    assert.ok(failedId);
    assert.equal((await db.query('SELECT state FROM projects WHERE id=$1', [failedId])).rows[0].state, 'failed');
    process.env.GIT_ROOT = join(temp, 'repositories');
    const partial = join(process.env.GIT_ROOT, `${failedId}.git`);
    await mkdir(partial);
    await writeFile(join(partial, 'HEAD'), 'ref: refs/heads/main\n');
    const repaired = new ProjectsService(db, new RepositoriesService());
    assert.equal((await repaired.retry(failedId)).state, 'active');
    assert.equal((await repaired.retry(failedId)).state, 'active');
  } finally {
    if (app) await app.close();
    await db.onModuleDestroy();
    await rm(temp, { recursive: true, force: true });
  }
});
