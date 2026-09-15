# Trellis

Плагин VS Code / Cursor с управляемым fork Grafel. Целевая поставка — один VSIX для Windows x64, включающий готовый движок и dashboard.

## Репозитории и структура

```text
Trellis/
├── AGENTS.md
├── module.md
├── .gitmodules
├── docs/           # Требования MVP и дорожная карта
├── grafel/          # Git submodule: SpamX-dev/grafel
├── plugin/          # Исходники расширения в основном репозитории
│   └── module.md
└── scripts/         # Автоматизация сборки и поставки
    └── module.md
```

- Продукт: https://github.com/SpamX-dev/Trellis
- Fork движка: https://github.com/SpamX-dev/grafel
- Upstream движка: https://github.com/cajasmota/grafel

Архитектурные границы описаны в [module.md](module.md) и документах компонентов. Первая версия расширения работает самостоятельно: боковая панель и стартовая вкладка отображают папки workspace. Grafel, индексация и MCP в версию 0.1.0 не включены.

## План MVP

- [Пользовательские истории](docs/requirements/UserStories.md)
- [Функциональные требования](docs/requirements/Functional.md)
- [Нефункциональные требования](docs/requirements/NonFunctional.md)
- [Дорожная карта по пользовательским историям](docs/plan/Roadmap.md)

Документы описывают целевой MVP; открытые решения и условия начала этапов отмечены в дорожной карте.

## Сборка плагина

Из директории `plugin/` с Node.js 22+:

```powershell
npm ci
npm run check
npm run package
```

Результат: `plugin/trellis-0.1.0.vsix`. Установите его через **Extensions: Install from VSIX…** в VS Code / Cursor. Инициализация Grafel для этой сборки не требуется. Инструкции запуска через F5 и интеграционных проверок находятся в [plugin/README.md](plugin/README.md).

## Получение исходников

```powershell
git clone --recurse-submodules https://github.com/SpamX-dev/Trellis.git
cd Trellis
```

Для уже клонированного репозитория:

```powershell
git submodule update --init --recursive
```

Submodule фиксирует конкретный коммит Grafel. После переключения ветки или получения изменений Trellis повторите `git submodule update --init --recursive`, предварительно сохранив незакоммиченные изменения в движке.

## Изменения движка

Перед редактированием создайте рабочую ветку внутри submodule: при обычном клонировании он находится на зафиксированном коммите, без активной ветки.

```powershell
git -C grafel switch -c trellis/my-change
```

Коммиты движка создаются и публикуются в `SpamX-dev/grafel`. После публикации нужного коммита обновите ссылку в корневом репозитории:

```powershell
git add grafel
git commit -m "Update Grafel revision"
git push --recurse-submodules=check
```

Изменения `plugin/`, `scripts/` и корневой документации коммитятся непосредственно в Trellis.

## Обновления upstream

Remote `upstream` настраивается внутри submodule. Локальные remotes не передаются при клонировании; в новой копии добавьте его один раз:

```powershell
git -C grafel remote add upstream https://github.com/cajasmota/grafel.git
git -C grafel fetch upstream
```

Обновления принимаются в отдельной ветке форка с проверкой совместимости. После публикации проверенного результата обновляется ссылка на Grafel в Trellis. Сборка не должна автоматически следовать за `upstream/main`.
