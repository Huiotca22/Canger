# canger — Minecraft Launcher

Настольный лаунчер Minecraft на **Tauri 2 + Rust + React**. Основной runtime приложения находится в `frontend/` и `src-tauri/`; Node.js backend в `src/` сохранён как legacy CLI/HTTP-сервис.

**Сайт проекта:** https://huiotca22.github.io/canger-site/
**Связь:** Telegram [@ponifug](https://t.me/ponifug) — баги, вопросы, предложения.

> **Платформа релиза 0.1.0 — Windows (x64).** Проверенные сборки: `NSIS` и `MSI`.
> Поддержка Linux в разработке: код собирается под Linux, иконки и bundle-таргеты
> `deb`/`appimage` настроены, но запуск на реальной Linux-машине ещё не подтверждён.
> macOS не поддерживается. План кроссплатформы — в разделе «Известные ограничения».

## Что реализовано

- загрузка Vanilla, Fabric, Forge и NeoForge-версий из официальных manifest-файлов;
- в каталоге Versions для каждой пары Minecraft + loader показывается одна
  последняя совместимая сборка (Fabric, Forge или NeoForge);
- автоматическая установка **Forge 1.13+**:
  - точная версия Minecraft и Forge build;
  - выбор `recommended` из `promotions_slim.json`, fallback на последний доступный build;
  - загрузка installer только с официального Forge Maven;
  - проверка SHA-1 installer и запуск `java -jar ... --installClient`;
  - проверка созданного Forge JSON и родительского клиента;
- автоматическая загрузка подходящей Java через официальный Adoptium API с проверкой SHA-256;
- изоляция игровых данных по версии:
  - `.minecraft/versions/<technical-version-id>/mods` — отдельные моды для Vanilla, Fabric, Forge и NeoForge;
  - там же версия хранит свои `saves`, `config`, `resourcepacks`, `shaderpacks`, `screenshots`, `logs` и `options.txt`;
  - общие `libraries`, `assets`, `objects` и Java-runtime не дублируются;
- поддержка старых схем Minecraft: native-библиотеки из `downloads.classifiers` (LWJGL 2.x/3.2.x) скачиваются и распаковываются, а не пропускаются молча;
- правила Mojang `os.version` разбираются как шаблоны версии (`^10\.` и т. п.), поэтому `rules` больше не отбрасываются целиком;
- установка сборок Modrinth/CurseForge честно сообщает о частичной установке и применяет `overrides/` из `.mrpack`;
- защита служебных файлов версии: `<id>.json`, `<id>.jar`, `vanilla.json` и `natives` не удаляются и не перезаписываются файловым менеджером;
- Profiles удалены из Tauri UI и IPC: выбранная версия сама определяет `--gameDir` и папку модов;
- CurseForge API-ключ читается из переменной окружения `CANGER_CURSEFORGE_API_KEY` или из файла `%APPDATA%\.minecraft\canger\settings.json` (ключ `curseforgeApiKey`); отдельного меню в приложении нет;
- старый `profiles.json` и legacy-данные не удаляются автоматически, но больше не участвуют в выборе версии или запуске.

## Forge

Forge устанавливается из карточки версии. Например, для Minecraft `1.20.1` UI получает точный build из официального promotions API, а не угадывает номер.

- Forge `1.13+`: автоматическая headless-установка.
- Forge `1.12.2` и старше: UI честно помечает установку как ручную. Старый installer не поддерживает безопасный headless client install.
- Forge устанавливается один раз в общий content root. Каждая техническая версия получает собственный `versions/<id>` в качестве `--gameDir`, поэтому миры и моды не смешиваются.

## Fabric и NeoForge

- В каталоге остаётся одна последняя совместимая карточка для каждой пары
  Minecraft + loader; historical build не засоряют список.
- NeoForge использует официальный `maven-metadata.xml` и выбирает последнюю стабильную
  сборку для точной Minecraft-версии (включая схему 26.x); renderer не передаёт URL installer.
- NeoForge installer скачивается с официального Maven, проверяется по SHA-256 и
  запускается в headless-режиме; после установки проверяются `id`, `inheritsFrom`,
  main class и родительский Vanilla JSON.
- NeoForge для 1.20.1 и более старых схем не добавляется;
  нестабильные `alpha`/`beta`/`snapshot` сборки фильтруются.

## Структура данных

```text
%APPDATA%\.minecraft\
  versions\                 Minecraft/Fabric/Forge/NeoForge JSON, JAR и natives
  versions\<id>\mods\        моды только этой технической версии
  versions\<id>\saves\       миры только этой версии
  versions\<id>\config\      конфиги только этой версии
  libraries\                 общие библиотеки
  assets\                    общие ресурсы
  runtime\                   Java
  canger\cache\forge\        проверенные Forge installer
  canger\cache\neoforge\     проверенные NeoForge installer
  canger\settings.json       настройки лаунчера (например, ключ CurseForge)
```

Legacy Node backend использует отдельный data root `~\.fps-launcher` и не делится
данными с Tauri-приложением: перенос данных между двумя средами не выполняется.

Файл `%APPDATA%\com.canger.launcher\profiles.json`, если он остался от старых
версий, больше не читается и не влияет на запуск.

При переходе на новую схему старые общие `%APPDATA%\.minecraft\mods` и данные
профилей не перемещаются автоматически: это сделано намеренно, чтобы не смешать
моды разных версий. Новая установка модов всегда идёт в выбранную папку
`versions\<id>\mods`.

## Запуск и сборка

Требуются Node.js `^20.19 || >=22.12`, Rust `1.89+` и системные зависимости Tauri.
Tauri CLI нужен отдельно:

```powershell
cargo install tauri-cli --version "^2"
```

```powershell
npm install
npm install --prefix frontend
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
.\run-tauri.ps1
```

Сборка установщиков (NSIS + MSI) выполняется только на Windows:

```powershell
npm run build --prefix frontend
cargo tauri build
```

Production frontend build:

```powershell
npm run build --prefix frontend
```

### Linux (Arch)

Зависимости Tauri на Arch:

```bash
sudo pacman -S --needed webkit2gtk-4.1 gtk3 libappindicator-gtk3 librsvg patchelf
```

Сборка пакета `deb` и `AppImage`:

```bash
npm install
npm install --prefix frontend
npm run build --prefix frontend
cargo tauri build
```

Или запуск в режиме разработки:

```bash
./run-tauri.sh
```

Таргеты для Linux заданы в `src-tauri/tauri.linux.conf.json`, поэтому сборка на
Windows продолжает делать только `NSIS` и `MSI`. Данные игры на Linux лежат в
`~/.minecraft` рядом с общими библиотеками и ассетами.

## Legacy Node backend

```powershell
node src/index.js --profiles
node src/index.js --versions
node src/index.js --launch --version 1.20.1 --username Steve --profile potato --dry
node src/index.js --server --port 17890
npm test
```

HTTP server всегда слушает только `127.0.0.1`, проверяет loopback/Host/Origin и не принимает `jvmExtra` или произвольный `instanceDir`.

CurseForge API требует пользовательский ключ. Меню для его ввода в приложении
нет: ключ задаётся переменной окружения

```powershell
$env:CANGER_CURSEFORGE_API_KEY = 'your-key'
```

или вручную файлом `%APPDATA%\.minecraft\canger\settings.json`:

```json
{ "curseforgeApiKey": "your-key" }
```

Ключ не хранится в исходниках. Без него поиск CurseForge отключается, Modrinth и установка Fabric/Forge/NeoForge продолжают работать.

## Известные ограничения

- Релиз 0.1.0 проверен на **Windows x64**: `NSIS` и `MSI`. Поддержка Linux в
  разработке — сборка и запуск на реальной Linux-машине ещё не подтверждены.
- macOS не поддерживается: нет `icon.icns`, не собирался и не тестировался.
- Windows-установщики (`NSIS`, `MSI`) не подписаны Authenticode: SmartScreen может
  показывать предупреждение до установки сертификата.
- Legacy `reqwest 0.11` и `zip 0.6` в `src-tauri/Cargo.toml` оставлены как есть:
  обновление требует отдельного прохода по API и не блокирует релиз.
- Перенос данных между Tauri-приложением и legacy Node backend не выполняется.

### План кроссплатформы (вне объёма 0.1.0)

1. Подтвердить сборку и запуск на Linux в дистрибутивах на базе Arch и Debian.
2. Иконка `icon.icns` и таргеты `app`/`dmg` для macOS.
3. Ветки поиска Java в `JAVA_HOME` и `~/.sdkman` для macOS.
4. Проверка оконного режима на Wayland с прозрачностью.

## Проверки безопасности

- IPC принимает только безопасные component names/ID; path traversal и удаление корня блокируются;
- загрузки используют HTTPS, exact-host allowlist и проверяемые redirect;
- загрузки идут во временный файл и атомарно переименовываются;
- Forge/NeoForge installer, Java, Mojang client и assets проверяются по checksum;
- mod-файлы проверяются на JAR/ZIP-формат, а для Modrinth дополнительно — по переданному SHA-1/SHA-512;
- JVM arguments из version JSON фильтруются: `-javaagent`, `-Xmx`, `-Xms` и command-execution callbacks не принимаются;
- ZIP extraction ограничивает paths, число entries, размер и compression ratio.
