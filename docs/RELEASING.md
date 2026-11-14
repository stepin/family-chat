# Выпуск версии

Как опубликовать проект в первый раз и как выпускать версии потом. Всё, что можно, делают workflow в
`.github/workflows/`; секреты не нужны, хватает встроенного `GITHUB_TOKEN`.

## Один раз, при публикации

1. **Репозиторий.** Создайте публичный репозиторий и отправьте в него ветку по умолчанию.
2. **Контакт для уязвимостей.** Впишите адрес в [SECURITY.md](../SECURITY.md) вместо `TO BE FILLED IN AT PUBLICATION`.
3. **Адреса в документации.** В `docs/` и `README.md` стоят заглушки: `https://code.example.org/family-chat`
   (репозиторий и страница выпусков) и `registry.example.org/family-chat/fcd` (образ). На сайте они заменяются
   при сборке значениями из `apps/site/site.config.mjs` (или переменных окружения `SITE_REPOSITORY_URL`,
   `SITE_IMAGE`; workflow сайта задаёт их сам по адресу репозитория). В самих файлах замените их одной командой:

   ```sh
   grep -rl 'code.example.org/family-chat\|registry.example.org/family-chat/fcd' README.md docs compose.yaml deploy \
     | xargs sed -i.bak -e 's#https://code.example.org/family-chat#https://github.com/<owner>/family-chat#g' \
                        -e 's#registry.example.org/family-chat/fcd#ghcr.io/<owner>/fcd#g'
   find . -name '*.bak' -delete
   ```

   Тест сайта следит, чтобы примеры в `deploy/` и `compose.yaml` совпадали с `docs/ADMIN.md`: меняйте их вместе.
4. **Лицензия.** Проверьте строку `Copyright` в [LICENSE](../LICENSE).
5. **Сайт.** В настройках репозитория: Pages, источник «GitHub Actions». Затем переменная репозитория
   `PAGES_ENABLED=true` (Settings, Secrets and variables, Actions, Variables). Без неё сайт собирается как
   артефакт, но не публикуется. Если сайт живёт не в подпапке `/<репозиторий>/`, а на своём домене, задайте
   переменную `SITE_BASE_PATH=/`.
6. **Образ.** После первого выпуска откройте пакет `fcd` в GitHub Packages и сделайте его публичным.

## Каждая версия

1. Версия в трёх местах должна совпадать: `server/Cargo.toml`, `apps/web/package.json`, `apps/site/package.json`.
   После правки `server/Cargo.toml` обновите `Cargo.lock`: `cargo update --workspace --manifest-path server/Cargo.toml`.
2. Раздел версии в [CHANGELOG.md](../CHANGELOG.md): что нового, что несовместимо, что проверено и на чём.
3. Все проверки из [CONTRIBUTING.md](../CONTRIBUTING.md) зелёные.
4. Тег и отправка:

   ```sh
   git tag -a v0.1.0 -m 'Family Chat 0.1.0'
   git push origin v0.1.0
   ```

5. Workflow `release.yml` по тегу:
   - собирает веб-приложение один раз;
   - собирает `fcd` для Linux (x86_64, aarch64, armv7, musl, через cargo-zigbuild), macOS (arm64, x86_64) и
     Windows (x86_64) скриптом `scripts/release.sh`; версия и коммит попадают в `fcd --version` и `/v1/hello`;
   - пишет `SHA256SUMS` и создаёт **черновик** выпуска с архивами и текстом раздела из `CHANGELOG.md`;
   - собирает образ для `linux/amd64`, `linux/arm64`, `linux/arm/v7` и отправляет его в
     `ghcr.io/<owner>/fcd` с тегами версии и `latest`.
6. Проверьте черновик (архивы, суммы, текст) и опубликуйте его вручную.

## Локальная сборка

```sh
scripts/release.sh --targets "aarch64-apple-darwin x86_64-unknown-linux-musl"
ls dist/release/
```

Подробности и способы сборки для чужих систем написаны в начале `scripts/release.sh`. Для воспроизводимости
зависимости зафиксированы (`pnpm-lock.yaml`, `Cargo.lock`), время в архивах берётся из `SOURCE_DATE_EPOCH` (время
коммита), пути машины сборки убраны из бинарника. Чтобы получить те же байты, нужны та же версия Rust и zig.
