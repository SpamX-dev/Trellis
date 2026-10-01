# План: серверный агент сбора требований

## Назначение

Запуск агента `product-capture` ([trellis-runtime/agents/product/agent.md](trellis-runtime/agents/product/agent.md)) как отдельного агента на сервере Runtime с диалогом. Runtime исполняет агента на собственном сервере: клонирует репозиторий проекта из Knowledge, агент работает с локальной копией, коммитит, Runtime пушит ветку предложения обратно в Knowledge. Knowledge принимает push только веток `proposals/*` и владеет проверкой и принятием; Tasks ведёт диалог; исполнитель — opencode.

## Решения

### ADR-1: opencode как внешний исполнитель

Место: `trellis-runtime/adr-opencode-executor.md`.

- Один долгоживущий процесс `opencode serve` (порт 4096, `OPENCODE_SERVER_PASSWORD`) на экземпляр Runtime; REST-клиент внутри Runtime.
- Задача — одна opencode-сессия; попытка — отправка сообщения и ожидание завершения; ответ человека — новое сообщение в той же сессии; отмена — `POST /session/:id/abort`.
- Пакет агента превращается в opencode-агента: `agent.md` — system prompt, декларации `model.ts` и примеры — файлы в рабочей копии, `AGENTS.md` в корне рабочей копии.
- Права opencode: `read`, `edit`, `glob`, `grep` внутри рабочей копии; `bash` ограничен политикой на `git *` (агент сам коммитит по `agent.md`, п.5); `webfetch` и `websearch` запрещены.
- Отчёт агента — последнее сообщение сессии; Runtime разбирает его через `parseTaskResult`. Вход задачи не меняется: `{ request }` (`parseTaskInput`); ответы человека — сообщения сессии, а не новые поля `TaskInput`.
- Модель задаётся конфигурацией Runtime (`provider/model`), а не пакетом.

### ADR-2: Git-транспорт и ветки предложений

Место: `trellis-knowledge/adr-agent-git-transport.md`.

- Runtime — отдельный сервер. Рабочую копию создаёт сам Runtime: клон репозитория проекта из Knowledge в изолированный каталог на сервере Runtime (`var/workspaces/<project>/<attempt>`).
- Начальный вариант — полный клон (репозиторий документный, мал); sparse-checkout нужных директорий добавить при росте объёма.
- Knowledge предоставляет агентам Git smart HTTP (push) с авторизацией токеном агента Knowledge (учётные записи агентов и токены уже реализованы). Git-identity коммитов — учётная запись агента.
- Агент работает локально и коммитит (по `agent.md`, п.5); Runtime пушит результат в ветку предложения `refs/heads/proposals/<attempt-id>`. Knowledge принимает push только в ветки `proposals/*`; push не меняет `main`.
- Knowledge фиксирует событие публикации ветки (Webhooks), проверяет предложение (Validation-домен, `parseStrictYaml`/`checkProductSnapshot`), человек принимает или отклоняет; принятие применяет к базовой ревизии и порождает `documents.accepted`.
- Рабочие копии и их очистка — владение Runtime; Knowledge владеет bare-репозиториями, push-транспортом и принятием. Прямой обмен файлами между серверами не используется.

### ADR-3: цикл диалога needs_input

Место: `trellis-tasks/adr-dialogue-loop.md`.

- Задача: `created` → `running` → `needs_input` (ждёт человека) → `running` → `completed` | `failed` | `cancelled`.
- `needs_input` не завершает задачу: Tasks сохраняет вопрос (из `summary` отчёта) и показывает его в Web; ответ человека создаёт новую попытку с продолжением той же opencode-сессии.
- Гейты (обязательные): `parseTaskInput` до запуска; `parseTaskResult` отчёта; для `completed` — Knowledge проверяет точный commit предложения через `checkProductSnapshot` (структура и связи). Незавершённый гейт не переводит задачу в завершённую.

## Фазы реализации

### Фаза A — Knowledge: push-транспорт и предложения

1. Новая доменная папка `trellis-knowledge/proposals/` (`module.md`, controller, service) и миграция таблицы предложений (проект, базовая ревизия, oid, автор-агент, состояние, решение человека).
2. Repositories: Git smart HTTP push для агентов — `git-http-backend` за контроллером, авторизация токеном агента, разрешён только push веток `proposals/*`; фиксация события публикации ветки.
3. Контракты: дополнить `contracts/projects-repositories.md` (push-транспорт, фильтр веток) и создать `contracts/proposals.md` (создание предложения, список и чтение веток предложений, принятие и отклонение человеком; права — `owner` и `user` принимают, агент ограничен своей веткой).
4. Переиспользование Framework: Validation-домен проверяет предложение через `parseStrictYaml` и `checkProductSnapshot`; при принятии — применение к базовой ревизии и событие `documents.accepted`.

### Фаза B — Runtime: harness opencode

5. Сборка пакета агента локально: `agent.md` + декларации из `src/product/model.ts` + примеры `examples/product` — файлы комплекта. Registry отложен: локальная работа с авторскими определениями агентов не требует Registry.
6. Адаптер opencode: REST-клиент `serve` (сессии, сообщения, abort), генерация opencode-агента с ограниченными правами.
7. Раннер попытки: приём `{ project, agent, attempt, request/answer }` → клон из Knowledge в каталог на сервере Runtime → сессия с `cwd` рабочей копии → чтение финального отчёта → `parseTaskResult` → возврат Tasks; для `completed` — commit в копии (если агент не закоммитил) и push ветки `proposals/<attempt-id>` в Knowledge; очистка каталога.

### Фаза C — Tasks: жизненный цикл и гейты

8. Сервис задач: создание по `{ request }`, состояние, история попыток, вопросы и ответы, журнал; назначение Runtime; отмена.
9. Гейты: вход и отчёт через Framework, снимок через Knowledge; завершение только после прохождения.
10. Подписки на `documents.accepted` для реакций (по `module.md`) — задел API, первая реакция минимальная.

### Фаза D — Web: панель задачи

11. `trellis-web`: создание задачи с запросом, просмотр состояния и попыток, вопрос агента — поле ответа, отчёт; проверка прав через существующий `api.ts`.

### Фаза E — Принятие человеком

12. Web и VS Code: просмотр предложения (дифф ветки), принятие и отклонение; событие `documents.accepted`; интерфейс чтения и принятия в `trellis-vscode`.

## Затрагиваемые файлы

- `trellis-runtime/agents/product/agent.md` — определение агента (не менять); его текст станет system prompt.
- `trellis-runtime/adr-opencode-executor.md`, `trellis-knowledge/adr-agent-git-transport.md`, `trellis-tasks/adr-dialogue-loop.md` — новые ADR.
- `trellis-runtime/module.md` — дополнить: harness opencode, клонирование и push, конфигурация модели, владение рабочими копиями.
- `trellis-knowledge/module.md`, `trellis-knowledge/repositories/module.md`, `trellis-knowledge/contracts/projects-repositories.md` — дополнить; новый `trellis-knowledge/contracts/proposals.md`.
- `trellis-tasks/module.md`, `trellis-web/src/workspace.tsx` — точки расширения.
- `trellis-framework/src/product/model.ts`, `snapshot.ts`, `validation.ts` — переиспользовать `parseTaskInput`, `parseTaskResult`, `parseStrictYaml`, `checkProductSnapshot`; экспорт текста деклараций для пакета.

## Проверки

1. ADR не противоречат границам `module.md`: Knowledge владеет bare-репозиториями, push-транспортом и принятием; Runtime — клонированием, рабочими копиями и исполнением; Tasks — состоянием и диалогом; права нигде не расширены.
2. Текст `agent.md` не требует правок: вход `{ request }`, отчёт `{ status, summary }`, размещение `documents/product/<type>/<id>.yaml`, гейты по Git-артефактам — покрыты проектом.
3. Сквозной сценарий диалога: запрос → `needs_input` с вопросом → ответ → `completed` → push предложения → снимок проходит `checkProductSnapshot` → человек принимает → `documents.accepted`.
4. Push-ограничение: агент не может пушить вне `proposals/*`; `main` не меняется.
5. `npm run check` (Markdown-ссылки новых файлов) и `npm test` — без изменений зелёные.
