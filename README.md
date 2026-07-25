# Zotero Reference SQLite

Локальный безопасный вариант Zotero Reference для Obsidian: использует локальный API Zotero, а если Zotero закрыт, читает `zotero.sqlite` через системный Windows SQLite. Python не требуется.

## Статус

Рабочая SQLite-версия Zotero-плагина. Сохранена как отдельный репозиторий, чтобы её можно было архивировать, передавать и при необходимости использовать независимо от основного развиваемого импортёра источников.

## Установка

Папка плагина должна находиться в:

```text
.obsidian/plugins/zotero-reference-sqlite
```

В текущем хранилище Obsidian эта папка подключена через junction-ссылку на отдельный репозиторий:

```text
S:/Users/HiDespondency/Documents/Obsidian Plugins/zotero-reference-sqlite
```

## Состав

- `manifest.json` - описание плагина для Obsidian.
- `main.js` - рабочий код плагина.
- `styles.css` - стили панели.
- `zotero_windows_sqlite.ps1` - чтение Zotero SQLite на Windows.

## Примечание

Пользовательская база, кэш и локальные настройки не входят в публичный код плагина.
