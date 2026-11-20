# Выпуск версии

Как открыть репозиторий в первый раз и как выпускать версии. Всё, что можно, делают workflow в
`.github/workflows/`; секреты не нужны, хватает встроенного `GITHUB_TOKEN`.

## Один раз: открыть репозиторий

Репозиторий проекта: https://github.com/stepin/family-chat. Документация, `compose.yaml` и примеры в `deploy/` уже
называют его и образ `ghcr.io/stepin/fcd`; CI следит, чтобы старые заглушки не вернулись. Шаги по порядку:

1. **Лицензия.** Решите строку `Copyright` в [LICENSE](../LICENSE).
2. **Сайт.** Settings, Pages, источник «GitHub Actions». Workflow `site.yml` публикует сайт на каждый push в `main`,
   только в репозитории `stepin/family-chat` (форки сайт только собирают). Сайт живёт по адресу
   https://stepin.github.io/family-chat/; для своего домена задайте переменную репозитория `SITE_BASE_PATH=/`.
3. **Сообщения об уязвимостях.** Settings, Code security, «Private vulnerability reporting»: включить. На это
   ссылается [SECURITY.md](../SECURITY.md).
4. **Влить изменения** в `main`.
5. **Тег** `v*` (раздел «Каждая версия» ниже). Workflow `release.yml` собирает файлы и образ.
6. **Черновик выпуска.** `release.yml` создаёт выпуск черновиком: проверьте архивы, суммы и текст, опубликуйте.
7. **Образ.** Откройте пакет `fcd` в GitHub Packages и сделайте его публичным.
8. **Проверка без входа.** `docker logout ghcr.io && docker pull ghcr.io/stepin/fcd:latest`; ссылки на файлы со
   страницы выпусков открываются.
9. **Только потом** откройте репозиторий (Settings, General, Change visibility), если он был закрытым.

Форк публикует свои файлы так же; на сайте его адреса задают `SITE_REPOSITORY_URL` и `SITE_IMAGE`
([apps/site/README.md](../apps/site/README.md)).

## Каждая версия

1. Версия в трёх местах должна совпадать: `server/Cargo.toml`, `apps/web/package.json`, `apps/site/package.json`.
   После правки `server/Cargo.toml` обновите `Cargo.lock`: `cargo update --workspace --manifest-path server/Cargo.toml`.
2. Раздел версии в [CHANGELOG.md](../CHANGELOG.md): что нового, что несовместимо, что проверено и на чём.
3. Все проверки из [CONTRIBUTING.md](../CONTRIBUTING.md) зелёные.
4. Тег и отправка:

   ```sh
   git tag -a v1.1.0 -m 'Family Chat 1.1.0'
   git push origin v1.1.0
   ```

5. Workflow `release.yml` по тегу:
   - собирает веб-приложение один раз;
   - собирает `fcd` для Linux (x86_64, aarch64, armv7, musl, через cargo-zigbuild), macOS (arm64, x86_64) и
     Windows (x86_64) скриптом `scripts/release.sh`; версия и коммит попадают в `fcd --version` и `/v1/hello`;
   - пишет `SHA256SUMS` и создаёт **черновик** выпуска с архивами и текстом раздела из `CHANGELOG.md`;
   - собирает образ для `linux/amd64`, `linux/arm64`, `linux/arm/v7` и отправляет его в
     `ghcr.io/stepin/fcd` с тегами версии и `latest` (только в репозитории `stepin/family-chat`).
6. Проверьте черновик (архивы, суммы, текст) и опубликуйте его вручную.

## Локальная сборка

```sh
scripts/release.sh --targets "aarch64-apple-darwin x86_64-unknown-linux-musl"
ls dist/release/
```

Подробности и способы сборки для чужих систем написаны в начале `scripts/release.sh`. Для воспроизводимости
зависимости зафиксированы (`pnpm-lock.yaml`, `Cargo.lock`), время в архивах берётся из `SOURCE_DATE_EPOCH` (время
коммита), пути машины сборки убраны из бинарника. Чтобы получить те же байты, нужны та же версия Rust и zig.
