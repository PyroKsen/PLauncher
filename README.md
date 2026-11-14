# PLauncher

## Casualties Unknown

Идентификатор игры в серверном `version.txt`: `CasualtiesUnknown`. Вкладка включена
в автоматическую и ручную проверку версий. Пока запись игры или ссылка отсутствует,
скачивание недоступно. Когда ссылка появится, она подхватится после проверки версий.

Запись внутри объекта `games` в `version.txt` на GitHub:

```json
"CasualtiesUnknown": {
  "version": "1",
  "downloadUrl": "",
  "dirName": "Casualties Unknown",
  "exeName": "CasualtiesUnknown.exe"
}
```

Заполните `downloadUrl` прямой ссылкой на ZIP. Лаунчер ожидает файл запуска
`Casualties Unknown/CasualtiesUnknown.exe` внутри выбранной папки установки игр.
`dirName` должен совпадать с единственной корневой папкой внутри ZIP. При новом архиве увеличивайте
`version`. Папки `Casualties Unknown` и `CasualtiesUnknown` исключены из git и сборки.

Фон вкладки: `assets/images/backgroundCasualtiesUnknown.png`. Изображение
масштабируется по размеру окна с сохранением пропорций.

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
