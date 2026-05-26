# PLauncher

## Сборка

Локальная сборка установщика без публикации:

```bash
npm run build
```

После сборки в `dist` появятся:

- `PLauncher-Setup-<version>.exe`
- `PLauncher-Setup-<version>.exe.blockmap`
- `latest.yml`

## Релиз через GitHub Releases

Перед релизом увеличьте версию в `package.json`, например с `1.0.0` на `1.0.1`.

Для публикации нужен GitHub token с правами на Releases:

```powershell
$env:GH_TOKEN="ваш_token"
npm run release
```

Команда создаёт draft release в репозитории `PyroKsen/PLauncher`. После проверки его нужно вручную опубликовать на GitHub. Автообновление видит только опубликованные releases, draft-версии пользователям недоступны.

Если загружать файлы вручную, в GitHub Release обязательно должны быть все три файла из `dist`:

- `PLauncher-Setup-<version>.exe`
- `PLauncher-Setup-<version>.exe.blockmap`
- `latest.yml`
