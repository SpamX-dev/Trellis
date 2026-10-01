import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.js';
import { Database } from './db.js';

/**
 * Запуск Knowledge API: применяет SQL-миграции до приёма HTTP-запросов.
 * Сервис не запускает Keycloak и не открывает Git-том внешним клиентам.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await app.get(Database).migrate();
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
