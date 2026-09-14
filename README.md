# Trellis

Плагин VS Code / Cursor с управляемым fork Grafel. Целевая поставка — один VSIX для Windows x64, включающий готовый движок и dashboard.

## Репозитории и структура

```text
Trellis/
├── AGENTS.md
├── module.md
├── .gitmodules
├── grafel/          # Git submodule: SpamX-dev/grafel
├── plugin/          # Исходники расширения в основном репозитории
│   └── module.md
└── scripts/         # Автоматизация сборки и поставки
    └── module.md
```

- Продукт: https://github.com/SpamX-dev/Trellis
- Fork движка: https://github.com/SpamX-dev/grafel
- Upstream движка: https://github.com/cajasmota/grafel

Архитектурные границы описаны в [module.md](module.md) и документах компонентов. Репозиторий содержит начальную структуру; сборка расширения и VSIX ещё не реализованы.

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
