# Сервер и прокси с CORS

Клиент Family Chat открывается со своего адреса (например, `https://chat.example.net`), а данные лежат в папке WebDAV
на роутере (например, `https://dav.example.net/family-chat/`). Это разные origin, поэтому браузер пускает клиента к
WebDAV, только если сервер отвечает с заголовками CORS (режим A, `docs/PLAN.md`, разделы 5, 6.11, 6.12). Штатные
WebDAV-серверы роутеров обычно этого не умеют. Тогда рядом ставится обратный прокси, который добавляет CORS, а сам
WebDAV роутера остаётся как есть.

Здесь два рецепта, оба проверяются в CI тем же зондом в браузере (`apps/web/e2e`), что и серверы для разработки:

| Рецепт | Файлы | Сертификат |
|---|---|---|
| Caddy | [`caddy/Caddyfile`](caddy/Caddyfile) | Caddy получает его сам (Let's Encrypt), если имя прокси видно из интернета |
| nginx | [`nginx/family-chat.conf`](nginx/family-chat.conf), [`nginx/fc-location.conf`](nginx/fc-location.conf), [`nginx/fc-cors-headers.conf`](nginx/fc-cors-headers.conf) | свой (например, certbot) |

Если ставить нечего и некуда, проще всего Caddy: один исполняемый файл, сертификат без настройки.

## Что делают рецепты

Требования раздела 6.12 плана:

- `Access-Control-Allow-Origin` с точным адресом клиента и `Vary: Origin`. Чужим адресам заголовок не отдаётся.
- Методы `GET, PUT, DELETE, MKCOL, PROPFIND, OPTIONS`; заголовки `Authorization, Depth, Content-Type` перечислены явно
  (звёздочка не покрывает `Authorization`).
- `Access-Control-Max-Age: 7200`, иначе каждый опрос платит предварительным запросом.
- `OPTIONS` отвечает сам прокси, без пароля, кодом 204.
- Заголовки CORS на всех ответах, включая ошибки (401, 404, 405, 409, 507). В nginx для этого `always`.
- `Access-Control-Expose-Headers: Date`: по нему клиент считает поправку часов. Там же `Access-Control-Max-Age`,
  `Content-Security-Policy` и `X-Content-Type-Options`, чтобы зонд мог проверить настройку из браузера.
- `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`: загруженный
  участником `.html` не становится страницей под семейным адресом.
- Пути не переписываются, перенаправлений нет, `Date` приходит от WebDAV-сервера.
- Клиент ходит без cookie (`credentials: omit`), поэтому `Access-Control-Allow-Credentials` не нужен.

## Caddy

1. Поставьте Caddy на устройство, которое всегда включено и видит роутер (сам роутер, если он позволяет ставить
   пакеты, мини-ПК, NAS). Имя прокси, например `dav.example.net`, должно вести на это устройство, а порты 80 и 443 быть
   доступны снаружи (для сертификата и для телефонов вне дома).
2. Положите [`caddy/Caddyfile`](caddy/Caddyfile) в `/etc/caddy/Caddyfile` и задайте переменные окружения:

   ```bash
   export FC_SITE_ADDRESS=dav.example.net
   export FC_CLIENT_ORIGIN=https://chat.example.net
   export FC_WEBDAV_UPSTREAM=192.168.1.1:5080
   caddy run --config /etc/caddy/Caddyfile
   ```

   Если WebDAV роутера отвечает только по HTTPS, укажите `FC_WEBDAV_UPSTREAM=https://192.168.1.1`. Для systemd
   переменные пишутся в `Environment=` юнита caddy.

   В Docker то же самое:

   ```bash
   docker run -d --name fc-proxy --restart unless-stopped -p 80:80 -p 443:443 \
     -e FC_SITE_ADDRESS=dav.example.net -e FC_CLIENT_ORIGIN=https://chat.example.net \
     -e FC_WEBDAV_UPSTREAM=192.168.1.1:5080 \
     -v $PWD/Caddyfile:/etc/caddy/Caddyfile:ro -v caddy-data:/data caddy:2-alpine
   ```

## nginx

1. Скопируйте `fc-location.conf` и `fc-cors-headers.conf` в `/etc/nginx/family-chat/`, а `family-chat.conf` в
   `/etc/nginx/conf.d/`.
2. В `family-chat.conf` замените три отмеченных значения: адрес клиента, адрес WebDAV роутера, имя прокси и пути к
   сертификату.
3. `nginx -t && nginx -s reload`.

nginx определяет адрес WebDAV при запуске: если роутер получил другой адрес, перезапустите nginx.

## Проверка

Откройте зонд на адресе клиента (`https://chat.example.net/probe/`), введите адрес папки через прокси, логин и пароль.
Ожидаемый вердикт: «Сервер подходит». Без браузера заголовки видно так:

```bash
curl -si -X OPTIONS -H 'Origin: https://chat.example.net' -H 'Access-Control-Request-Method: PROPFIND' https://dav.example.net/family-chat/
```

В ответе должны быть `204`, `Access-Control-Allow-Origin: https://chat.example.net` и `Access-Control-Max-Age: 7200`.

## Готовые серверы с CORS

Вместо прокси можно поставить WebDAV-сервер, который умеет CORS сам. dufs (`dufs --enable-cors`) проходит зонд с
вердиктом «Сервер подходит», но отдаёт `Access-Control-Allow-Origin: *` без `Access-Control-Max-Age` и без
`Content-Security-Policy: sandbox`, поэтому зонд показывает предупреждения. Если dufs стоит за Caddy или nginx из этих
рецептов, предупреждений нет.

## Клиент и WebDAV на одном домашнем устройстве

Вариант без хостинга проекта (раздел 6.12): на одном устройстве два имени, например `chat.home.example.net` отдаёт
папку клиента только для чтения, а `dav.home.example.net` проксирует WebDAV по этому рецепту с
`FC_CLIENT_ORIGIN=https://chat.home.example.net`. Это тоже режим A: origin разные. Проверяется в M0.

## Разработка

`tools/dav-dev` поднимает в Docker WebDAV без CORS (Apache) и оба рецепта перед ним, а также dufs. Конфигурации
рецептов подключаются оттуда как есть.
