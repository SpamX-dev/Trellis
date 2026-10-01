import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { BadRequestException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';

/**
 * Запуск Git без оболочки: аргументы не интерпретируются PowerShell или sh,
 * вывод ограничен по размеру и времени. Это единственный способ обращения
 * Repositories к Git; HTTP-клиент не получает серверный путь к репозиторию.
 */
export class GitCommand {
  async run(args: string[], options: { input?: string; env?: NodeJS.ProcessEnv; maxBytes?: number } = {}): Promise<Buffer> {
    return new Promise((resolveResult, reject) => {
      const child = spawn('git', args, { shell: false, windowsHide: true, env: { ...process.env, ...options.env } });
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      let total = 0;
      let done = false;
      const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
      const timer = setTimeout(() => child.kill(), 15_000);
      const fail = (error: Error) => { if (!done) { done = true; clearTimeout(timer); reject(error); } };
      child.on('error', fail);
      child.stdout.on('data', (part: Buffer) => {
        total += part.length;
        if (total > maxBytes) { child.kill(); fail(new PayloadTooLargeException('Слишком большой вывод Git')); }
        else output.push(part);
      });
      child.stderr.on('data', (part: Buffer) => errors.push(part));
      child.on('close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (code === 0) resolveResult(Buffer.concat(output));
        else reject(new Error(`git ${args[0]}: ${Buffer.concat(errors).toString('utf8').slice(0, 300)}`));
      });
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }
}

/**
 * Repositories владеет только bare Git-хранилищем, точными коммитами и чтением
 * деревьев. Проектные разрешения проверяет вызывающий Projects-контроллер;
 * здесь нет публикации, рабочего дерева или обхода symlink через файловую систему.
 */
@Injectable()
export class RepositoriesService {
  private readonly root = resolve(process.env.GIT_ROOT ?? 'var/trellis-repositories');
  private readonly git = new GitCommand();

  private path(projectId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(projectId)) throw new BadRequestException('Неверный ID проекта');
    return join(this.root, `${projectId}.git`);
  }

  private async inRepo(projectId: string, args: string[], maxBytes?: number): Promise<Buffer> {
    return this.git.run(['-C', this.path(projectId), ...args], { maxBytes });
  }

  async ensure(projectId: string): Promise<string> {
    const repository = this.path(projectId);
    await mkdir(this.root, { recursive: true });
    try {
      const existing = await lstat(repository);
      if (!existing.isDirectory()) throw new Error('Путь Git не является каталогом');
      const entries = await readdir(repository);
      let bare = '';
      try { bare = (await this.inRepo(projectId, ['rev-parse', '--is-bare-repository'])).toString('utf8').trim(); }
      catch {
        if (entries.length && !entries.some((name) => ['HEAD', 'objects', 'config'].includes(name))) {
          throw new Error('Существующий каталог не похож на Git-репозиторий');
        }
        await this.git.run(['init', '--bare', '--initial-branch=main', repository]);
        bare = (await this.inRepo(projectId, ['rev-parse', '--is-bare-repository'])).toString('utf8').trim();
      }
      if (bare !== 'true') throw new Error('Существующий путь не является bare Git-репозиторием');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.git.run(['init', '--bare', '--initial-branch=main', repository]);
    }
    try {
      return await this.head(projectId);
    } catch {
      const tree = (await this.git.run(['-C', repository, 'mktree'], { input: '' })).toString('utf8').trim();
      const env = { GIT_AUTHOR_NAME: 'Trellis', GIT_AUTHOR_EMAIL: 'trellis@local', GIT_COMMITTER_NAME: 'Trellis', GIT_COMMITTER_EMAIL: 'trellis@local' };
      const commit = (await this.git.run(['-C', repository, 'commit-tree', tree, '-m', 'Initial empty project'], { env })).toString('utf8').trim();
      await this.inRepo(projectId, ['update-ref', 'refs/heads/main', commit, '']);
      return commit;
    }
  }

  async head(projectId: string): Promise<string> {
    return (await this.inRepo(projectId, ['rev-parse', '--verify', 'refs/heads/main^{commit}'])).toString('utf8').trim();
  }

  async exactCommit(projectId: string, oid: string): Promise<string> {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(oid)) throw new BadRequestException('Нужен полный commit ID');
    try {
      const actual = (await this.inRepo(projectId, ['rev-parse', '--verify', `${oid}^{commit}`])).toString('utf8').trim();
      if (actual.toLowerCase() !== oid.toLowerCase()) throw new Error('Не точный commit ID');
      await this.inRepo(projectId, ['merge-base', '--is-ancestor', actual, 'refs/heads/main']);
      return actual;
    } catch {
      throw new NotFoundException('Коммит не найден в main');
    }
  }

  async history(projectId: string, skip: number): Promise<unknown[]> {
    if (!Number.isSafeInteger(skip) || skip < 0 || skip > 100_000) throw new BadRequestException('Неверная страница');
    const raw = (await this.inRepo(projectId, ['log', 'refs/heads/main', '--format=%H%x09%aI%x09%an%x09%s', '--max-count=50', `--skip=${skip}`])).toString('utf8');
    return raw.trim() ? raw.trimEnd().split('\n').map((line) => {
      const [oid, date, author, subject] = line.split('\t');
      return { oid, date, author, subject };
    }) : [];
  }

  safePath(value: string, allowEmpty = false): string {
    if (allowEmpty && value === '') return '';
    if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('/') || value.endsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new BadRequestException('Недопустимый относительный путь');
    }
    return value;
  }

  async tree(projectId: string, oid: string, path: string): Promise<unknown[]> {
    const exact = await this.exactCommit(projectId, oid);
    const safe = this.safePath(path, true);
    let raw: Buffer;
    try {
      raw = await this.inRepo(projectId, ['ls-tree', '-z', safe ? `${exact}:${safe}` : exact]);
    } catch {
      throw new NotFoundException('Каталог не найден');
    }
    return raw.toString('utf8').split('\0').filter(Boolean).map((entry) => {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]*)$/.exec(entry);
      if (!match) throw new Error('Неверный ответ Git');
      return { mode: match[1], type: match[2], oid: match[3], name: match[4] };
    });
  }

  async blob(projectId: string, oid: string, path: string): Promise<{ content: string; mode: string; size: number }> {
    const exact = await this.exactCommit(projectId, oid);
    const safe = this.safePath(path);
    const segments = safe.split('/');
    const name = segments.pop();
    const entries = await this.tree(projectId, exact, segments.join('/')) as { name: string; mode: string; type: string }[];
    const entry = entries.find((item) => item.name === name);
    if (!entry || entry.type !== 'blob') throw new NotFoundException('Файл не найден');
    const size = Number((await this.inRepo(projectId, ['cat-file', '-s', `${exact}:${safe}`])).toString('utf8').trim());
    if (size > 1024 * 1024) throw new PayloadTooLargeException('Файл больше 1 МиБ');
    const content = (await this.inRepo(projectId, ['show', `${exact}:${safe}`], 1024 * 1024 + 1024)).toString('utf8');
    return { content, mode: entry.mode, size };
  }
}
