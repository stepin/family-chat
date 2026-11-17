//! `fcd`: Family Chat server.

// First: the `tr!` macro is used by every module below.
#[macro_use]
pub mod lang;
pub mod api;
pub mod app;
pub mod assets;
pub mod blobs;
pub mod check;
pub mod config;
pub mod datadir;
pub mod envelope;
pub mod error;
pub mod eventlog;
pub mod families;
pub mod groups;
pub mod headers;
pub mod healthcheck;
pub mod ids;
pub mod notice;
pub mod packs;
pub mod ratelimit;
pub mod store;
pub mod telegram;
pub mod tls;
pub mod webpush;

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::time::Duration;

use clap::{Parser, Subcommand};
use tokio::sync::watch;

use crate::assets::Assets;
use crate::config::Overrides;
use crate::datadir::DataDir;

/// Version of this build.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Git commit of this build (12 hex digits), empty when unknown.
pub const GIT_COMMIT: &str = env!("FCD_GIT_COMMIT");

/// `1.0.0 (commit 0123456789ab)`, or `1.0.0` when the commit is unknown.
pub const VERSION_LINE: &str = env!("FCD_VERSION_LINE");

/// The command line. Help texts are set at run time in the chosen language
/// ([`command`]); the doc comments here are for developers.
#[derive(Debug, Parser)]
#[command(name = "fcd", version = VERSION_LINE, disable_help_subcommand = true)]
pub struct Cli {
    /// Data folder.
    #[arg(long, global = true, value_name = "DIR")]
    pub data: Option<PathBuf>,
    /// TCP port.
    #[arg(long, global = true)]
    pub port: Option<u16>,
    /// IP address to listen on.
    #[arg(long, global = true, value_name = "IP")]
    pub listen: Option<String>,
    /// Family name.
    #[arg(long)]
    pub family_name: Option<String>,
    /// Retention, days.
    #[arg(long, value_name = "DAYS")]
    pub retention_days: Option<u32>,
    /// File size limit, MB.
    #[arg(long, value_name = "MB")]
    pub max_file_mb: Option<u64>,
    /// Web Push.
    #[arg(long, value_name = "BOOL", value_parser = parse_bool)]
    pub push: Option<bool>,
    /// X-Forwarded-For for rate limiting.
    #[arg(long, value_name = "BOOL", value_parser = parse_bool)]
    pub trust_forwarded_for: Option<bool>,
    /// Contact sent to push services (RFC 8292).
    #[arg(long, value_name = "URI", value_parser = parse_push_subject)]
    pub push_subject: Option<String>,
    /// Free disk space floor, MB.
    #[arg(long, value_name = "MB")]
    pub min_free_mb: Option<u64>,
    /// Telegram bot token for sticker sets by link (secret; prefer the file or the variable).
    #[arg(long, value_name = "TOKEN", value_parser = parse_secret)]
    pub telegram_bot_token: Option<config::Secret>,
    /// A file with the Telegram bot token.
    #[arg(long, value_name = "FILE")]
    pub telegram_bot_token_file: Option<String>,
    /// Telegram Bot API address.
    #[arg(long, value_name = "URL")]
    pub telegram_api_url: Option<String>,
    /// Allow http:// for the Bot API address beyond loopback.
    #[arg(long, value_name = "BOOL", value_parser = parse_bool)]
    pub telegram_api_allow_http: Option<bool>,
    /// Web client from a folder.
    #[arg(long, value_name = "DIR")]
    pub web_dir: Option<PathBuf>,
    /// HTTPS certificate chain.
    #[arg(long, value_name = "PEM", requires = "tls_key")]
    pub tls_cert: Option<PathBuf>,
    /// HTTPS private key.
    #[arg(long, value_name = "PEM", requires = "tls_cert")]
    pub tls_key: Option<PathBuf>,
    /// Language of the console output; read before parsing, see [`lang`].
    #[arg(long, global = true, value_name = "LANG", value_parser = ["ru", "en"], hide_possible_values = true)]
    pub lang: Option<String>,
    #[command(subcommand)]
    pub command: Option<Command>,
}

/// `true`, `false`, `1` or `0` (any case), for flags and environment variables.
pub fn parse_bool(v: &str) -> Result<bool, String> {
    match v.trim().to_ascii_lowercase().as_str() {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        _ => Err(lang::l("нужно true, false, 1 или 0", "expected true, false, 1 or 0").to_string()),
    }
}

/// A secret flag value (never echoed back in errors).
fn parse_secret(v: &str) -> Result<config::Secret, String> {
    Ok(config::Secret::new(v.trim()))
}

/// `mailto:` or `https://` contact for push services; errors give the value.
pub fn parse_push_subject(v: &str) -> Result<String, String> {
    let v = v.trim();
    if v.starts_with("mailto:") || v.starts_with("https://") {
        Ok(v.to_string())
    } else {
        Err(lang::l("нужно mailto: или https://", "expected mailto: or https://").to_string())
    }
}

/// Environment variables: every option of the command line, by its
/// argument id. A variable counts exactly like its flag (a flag on the
/// command line wins); an empty variable counts as not set. Order of
/// precedence: flag, variable, `config.toml`, default.
pub const ENV_VARS: &[(&str, &str)] = &[
    ("data", "FCD_DATA"),
    ("port", "FCD_PORT"),
    ("listen", "FCD_LISTEN"),
    ("family_name", "FCD_FAMILY_NAME"),
    ("retention_days", "FCD_RETENTION_DAYS"),
    ("max_file_mb", "FCD_MAX_FILE_MB"),
    ("push", "FCD_PUSH"),
    ("trust_forwarded_for", "FCD_TRUST_FORWARDED_FOR"),
    ("push_subject", "FCD_PUSH_SUBJECT"),
    ("min_free_mb", "FCD_MIN_FREE_MB"),
    ("telegram_bot_token", "FCD_TELEGRAM_BOT_TOKEN"),
    ("telegram_bot_token_file", "FCD_TELEGRAM_BOT_TOKEN_FILE"),
    ("telegram_api_url", "FCD_TELEGRAM_API_URL"),
    ("telegram_api_allow_http", "FCD_TELEGRAM_API_ALLOW_HTTP"),
    ("web_dir", "FCD_WEB_DIR"),
    ("tls_cert", "FCD_TLS_CERT"),
    ("tls_key", "FCD_TLS_KEY"),
    ("lang", "FCD_LANG"),
];

fn env_name(id: &str) -> Option<&'static str> {
    ENV_VARS.iter().find(|(k, _)| *k == id).map(|(_, v)| *v)
}

impl Cli {
    /// Fills the options not given on the command line from the environment
    /// (`get` reads one variable; tests pass their own). Errors name the variable.
    pub fn apply_env(&mut self, get: impl Fn(&str) -> Option<String>) -> Result<(), String> {
        let var = |id: &str| env_name(id).and_then(|n| lang::non_empty(&get, n).map(|v| (n, v)));
        let bad = |name: &str, value: &str, why: &str| {
            tr!(
                "переменная окружения {name}: недопустимое значение «{value}»: {why}",
                "environment variable {name}: invalid value “{value}”: {why}"
            )
        };
        fn num<T: std::str::FromStr>(v: &str) -> Option<T> {
            v.trim().parse().ok()
        }
        if self.data.is_none() {
            self.data = var("data").map(|(_, v)| PathBuf::from(v));
        }
        if self.port.is_none()
            && let Some((n, v)) = var("port")
        {
            self.port = Some(num(&v).ok_or_else(|| {
                bad(
                    n,
                    &v,
                    lang::l(
                        "нужен номер порта от 0 до 65535",
                        "expected a port number from 0 to 65535",
                    ),
                )
            })?);
        }
        if self.listen.is_none() {
            self.listen = var("listen").map(|(_, v)| v.trim().to_string());
        }
        if self.family_name.is_none() {
            self.family_name = var("family_name").map(|(_, v)| v);
        }
        if self.retention_days.is_none()
            && let Some((n, v)) = var("retention_days")
        {
            self.retention_days = Some(num(&v).ok_or_else(|| {
                bad(
                    n,
                    &v,
                    lang::l("нужно целое число дней", "expected a whole number of days"),
                )
            })?);
        }
        if self.max_file_mb.is_none()
            && let Some((n, v)) = var("max_file_mb")
        {
            self.max_file_mb = Some(num(&v).ok_or_else(|| {
                bad(
                    n,
                    &v,
                    lang::l("нужно целое число мегабайт", "expected a whole number of megabytes"),
                )
            })?);
        }
        if self.push.is_none()
            && let Some((n, v)) = var("push")
        {
            self.push = Some(parse_bool(&v).map_err(|why| bad(n, &v, &why))?);
        }
        if self.trust_forwarded_for.is_none()
            && let Some((n, v)) = var("trust_forwarded_for")
        {
            self.trust_forwarded_for = Some(parse_bool(&v).map_err(|why| bad(n, &v, &why))?);
        }
        if self.push_subject.is_none()
            && let Some((n, v)) = var("push_subject")
        {
            self.push_subject = Some(parse_push_subject(&v).map_err(|why| bad(n, &v, &why))?);
        }
        if self.min_free_mb.is_none()
            && let Some((n, v)) = var("min_free_mb")
        {
            self.min_free_mb = Some(num(&v).ok_or_else(|| {
                bad(
                    n,
                    &v,
                    lang::l(
                        "нужно целое число мегабайт (0 — не проверять)",
                        "expected a whole number of megabytes (0: no check)",
                    ),
                )
            })?);
        }
        // The token is a secret: never part of an error message.
        if self.telegram_bot_token.is_none() {
            self.telegram_bot_token = var("telegram_bot_token").map(|(_, v)| config::Secret::new(v.trim()));
        }
        if self.telegram_bot_token_file.is_none() {
            self.telegram_bot_token_file = var("telegram_bot_token_file").map(|(_, v)| v.trim().to_string());
        }
        if self.telegram_api_url.is_none() {
            self.telegram_api_url = var("telegram_api_url").map(|(_, v)| v.trim().to_string());
        }
        if self.telegram_api_allow_http.is_none()
            && let Some((n, v)) = var("telegram_api_allow_http")
        {
            self.telegram_api_allow_http = Some(parse_bool(&v).map_err(|why| bad(n, &v, &why))?);
        }
        if self.web_dir.is_none() {
            self.web_dir = var("web_dir").map(|(_, v)| PathBuf::from(v));
        }
        if self.tls_cert.is_none() {
            self.tls_cert = var("tls_cert").map(|(_, v)| PathBuf::from(v));
        }
        if self.tls_key.is_none() {
            self.tls_key = var("tls_key").map(|(_, v)| PathBuf::from(v));
        }
        if self.lang.is_none()
            && let Some((n, v)) = var("lang")
        {
            let v = v.trim().to_string();
            if v != "ru" && v != "en" {
                return Err(bad(n, &v, lang::l("нужно ru или en", "expected ru or en")));
            }
            self.lang = Some(v);
        }
        if self.tls_cert.is_some() != self.tls_key.is_some() {
            return Err(lang::l(
                "для HTTPS нужны оба: --tls-cert (FCD_TLS_CERT) и --tls-key (FCD_TLS_KEY)",
                "HTTPS needs both: --tls-cert (FCD_TLS_CERT) and --tls-key (FCD_TLS_KEY)",
            )
            .to_string());
        }
        Ok(())
    }
}

/// Texts of `--help` in both languages. Argument ids are the field names.
struct HelpText {
    about: (&'static str, &'static str),
    long_about: (&'static str, &'static str),
    after_help: (&'static str, &'static str),
    args: &'static [(&'static str, &'static str, &'static str)],
}

const HELP: HelpText = HelpText {
    about: (
        "Сервер Family Chat: семейный чат со сквозным шифрованием и встроенным веб-приложением",
        "Family Chat server: end-to-end encrypted family chat with the web client built in",
    ),
    long_about: (
        "Сервер Family Chat: семейный чат со сквозным шифрованием и встроенным веб-приложением.\n\n\
         Отдаёт веб-приложение и API на одном порту, хранит в папке данных только шифр, не дольше \
         --retention-days дней, и отправляет уведомления Web Push.",
        "Family Chat server: end-to-end encrypted family chat with the web client built in.\n\n\
         Serves the web app and the API on one port, keeps only encrypted data in the data \
         folder, at most --retention-days days, and sends Web Push notifications.",
    ),
    after_help: (
        "\
Настройки лежат и в <DIR>/config.toml (он пишется при первом запуске); флаги важнее файла.
Каждый параметр, кроме --data, есть и в config.toml; lang пишется туда же флагом --lang.

Примеры:
  fcd --data /srv/family-chat                     первый запуск печатает адрес и код администратора сервера
  fcd --data /srv/family-chat --port 8080 --listen 127.0.0.1
  fcd --data /srv/family-chat --tls-cert fullchain.pem --tls-key privkey.pem
  fcd reset-admin-code --data /srv/family-chat    новый код администратора сервера (при остановленном сервере)
  fcd families list --data /srv/family-chat       семьи сервера и их id
  fcd admin list --data /srv/family-chat --family <id>   (при остановленном сервере)
  fcd healthcheck --data /srv/family-chat         код выхода 0, если сервер отвечает

У каждого параметра есть переменная окружения (в скобках); порядок: флаг, переменная, config.toml, значение
по умолчанию. Пустая переменная не считается. Логические значения: true, false, 1, 0.
Язык: --lang ru|en (FCD_LANG), иначе lang в config.toml, иначе LC_ALL, LC_MESSAGES, LANG; по умолчанию русский.
Журнал: RUST_LOG=debug для подробностей, NO_COLOR=1 для вывода без цвета.",
        "\
Settings also live in <DIR>/config.toml (written at first start); flags win over the file.
Every option except --data is also a key in config.toml; lang is written there by --lang too.

Examples:
  fcd --data /srv/family-chat                     first start prints the address and the server admin code
  fcd --data /srv/family-chat --port 8080 --listen 127.0.0.1
  fcd --data /srv/family-chat --tls-cert fullchain.pem --tls-key privkey.pem
  fcd reset-admin-code --data /srv/family-chat    a new server admin code (server stopped)
  fcd families list --data /srv/family-chat       the server's families and their ids
  fcd admin list --data /srv/family-chat --family <id>   (server stopped)
  fcd healthcheck --data /srv/family-chat         exit code 0 when the server answers

Every option has an environment variable (in brackets); precedence: flag, variable, config.toml,
default. An empty variable counts as not set. Booleans: true, false, 1, 0.
Language: --lang ru|en (FCD_LANG), else lang in config.toml, else LC_ALL, LC_MESSAGES, LANG; Russian by default.
Logging: RUST_LOG=debug for more detail, NO_COLOR=1 for plain output.",
    ),
    args: &[
        (
            "data",
            "Папка данных: создаётся при первом запуске, в ней всё, что хранит сервер.",
            "Data folder: created on first start, holds everything the server keeps.",
        ),
        (
            "port",
            "TCP-порт для HTTP (или HTTPS с --tls-cert) [по умолчанию: 8787].",
            "TCP port for HTTP (or HTTPS with --tls-cert) [default: 8787].",
        ),
        (
            "listen",
            "IP-адрес, на котором слушать; 127.0.0.1 за обратным прокси на той же машине [по умолчанию: 0.0.0.0].",
            "IP address to listen on; 127.0.0.1 behind a reverse proxy on the same machine [default: 0.0.0.0].",
        ),
        (
            "family_name",
            "Имя семьи, его видят участники [по умолчанию: Семья].",
            "Family name shown to members [default: Family].",
        ),
        (
            "retention_days",
            "Сколько сервер хранит сообщения и файлы, дней, 7-90 [по умолчанию: 90].",
            "How long the server keeps messages and files, days, 7-90 [default: 90].",
        ),
        (
            "max_file_mb",
            "Предел размера одного файла (вложения), МБ [по умолчанию: 200].",
            "Size limit of one file (attachment), MB [default: 200].",
        ),
        (
            "push",
            "Уведомления Web Push; false: сервер не обращается к push-сервисам (без токена Telegram ни к каким внешним адресам) [по умолчанию: true].",
            "Web Push notifications; false: the server never contacts push services (without a Telegram token, no outside address at all) [default: true].",
        ),
        (
            "trust_forwarded_for",
            "Брать адрес клиента для ограничения частоты из X-Forwarded-For; только за обратным прокси, который его выставляет [по умолчанию: false].",
            "Take the client address for rate limiting from X-Forwarded-For; only behind a reverse proxy that sets it [default: false].",
        ),
        (
            "push_subject",
            "Контакт для push-сервисов (RFC 8292): mailto:адрес или https://адрес; адрес по умолчанию некоторые сервисы отклоняют [по умолчанию: mailto:fcd-admin@example.org].",
            "Contact sent to push services (RFC 8292): mailto:address or https://address; some services reject the default [default: mailto:fcd-admin@example.org].",
        ),
        (
            "min_free_mb",
            "Если свободного места на диске меньше, МБ, новые сообщения и файлы не принимаются; 0 — не проверять [по умолчанию: 100].",
            "Below this much free disk space, MB, new messages and files are refused; 0: no check [default: 100].",
        ),
        (
            "telegram_bot_token",
            "Токен бота Telegram для загрузки наборов стикеров по ссылке t.me/addstickers/…; пусто — выключено. Значение флага видно в списке процессов: лучше --telegram-bot-token-file или переменная.",
            "Telegram bot token for loading sticker sets by link t.me/addstickers/…; empty: off. A flag value shows in the process list: prefer --telegram-bot-token-file or the variable.",
        ),
        (
            "telegram_bot_token_file",
            "Файл с токеном бота Telegram (секреты Docker и Podman).",
            "A file with the Telegram bot token (Docker and Podman secrets).",
        ),
        (
            "telegram_api_url",
            "Адрес Telegram Bot API (свой telegram-bot-api без --local) [по умолчанию: https://api.telegram.org].",
            "Telegram Bot API address (own telegram-bot-api without --local) [default: https://api.telegram.org].",
        ),
        (
            "telegram_api_allow_http",
            "Разрешить http:// в --telegram-api-url не только для 127.0.0.1 и localhost (своя сеть compose) [по умолчанию: false].",
            "Allow http:// in --telegram-api-url beyond 127.0.0.1 and localhost (own compose network) [default: false].",
        ),
        (
            "web_dir",
            "Отдавать веб-приложение из этой папки вместо встроенной копии (для разработки).",
            "Serve the web client from this folder instead of the built-in copy (development).",
        ),
        (
            "tls_cert",
            "Отдавать HTTPS с этой цепочкой сертификатов (PEM, сначала сертификат сервера); нужен --tls-key.",
            "Serve HTTPS with this certificate chain (PEM, server certificate first); needs --tls-key.",
        ),
        (
            "tls_key",
            "Закрытый ключ к --tls-cert (PEM: PKCS#8, PKCS#1 или SEC1).",
            "Private key for --tls-cert (PEM: PKCS#8, PKCS#1 or SEC1).",
        ),
        (
            "lang",
            "Язык вывода: ru или en [по умолчанию: из config.toml или из LC_ALL, LC_MESSAGES, LANG, иначе ru].",
            "Language of the output: ru or en [default: from config.toml or LC_ALL, LC_MESSAGES, LANG, else ru].",
        ),
        ("help", "Показать справку", "Print help"),
        ("version", "Показать версию", "Print version"),
        (
            "user_id",
            "userId участника (26 символов).",
            "The member's userId (26 characters).",
        ),
        (
            "family",
            "Семья: id из `fcd families list` (для reset-admin-code также root); без флага корневая семья.",
            "The family: an id from `fcd families list` (reset-admin-code also takes root); the root family without it.",
        ),
        (
            "strict",
            "Сломанные семьи тоже дают код выхода 1.",
            "Broken families also give exit code 1.",
        ),
    ],
};

/// Subcommands: (path, Russian about, English about).
const SUBCOMMANDS: &[(&str, &str, &str)] = &[
    (
        "reset-admin-code",
        "Без --family: новый код администратора сервера (им создают семьи), старый перестаёт работать. \
         С --family: одноразовый код восстановления этой семьи, вход по нему делает администратором. \
         Сначала остановите сервер.",
        "Without --family: a new server admin code (it creates families), the old one stops working. \
         With --family: a one-time recovery code of that family; joining with it makes an administrator. \
         Stop the server first.",
    ),
    ("families", "Семьи этого сервера.", "Families of this server."),
    (
        "families list",
        "id, имя и состояние каждой семьи; только чтение, работает при запущенном сервере.",
        "Id, name and state of every family; read only, works while the server runs.",
    ),
    (
        "admin",
        "Управление администраторами (сначала остановите сервер).",
        "Manage administrators (stop the server first).",
    ),
    (
        "admin list",
        "Участники с их userId, именем и ролью.",
        "List members with their userId, name and role.",
    ),
    (
        "admin add",
        "Сделать участника администратором (userId из `fcd admin list`).",
        "Make a member an administrator (userId from `fcd admin list`).",
    ),
    (
        "healthcheck",
        "Проверить, что сервер на этой машине отвечает; код выхода 0, если да, 1, если нет. \
         Порт берётся из --port или <DIR>/config.toml; работает при запущенном сервере.",
        "Check that the server on this machine answers; exit code 0 if it does, 1 if not. \
         Reads the port from --port or <DIR>/config.toml; works while the server runs.",
    ),
];

fn pick(lang: lang::Lang, t: (&'static str, &'static str)) -> &'static str {
    if lang == lang::Lang::En { t.1 } else { t.0 }
}

/// Help texts, headings and the help and version flags of a command and its
/// subcommands, in `lang`. `path` is the subcommand path ("" for fcd itself,
/// "admin list" for a nested one).
fn localize(mut cmd: clap::Command, lang: lang::Lang, path: &str) -> clap::Command {
    use clap::{Arg, ArgAction};
    let en = lang == lang::Lang::En;
    let root = path.is_empty();
    let (usage, args_h, options_h, commands_h) = if en {
        ("Usage:", "Arguments", "Options", "Commands")
    } else {
        ("Использование:", "Аргументы", "Параметры", "Команды")
    };
    cmd = cmd
        .disable_help_flag(true)
        .arg(Arg::new("help").short('h').long("help").action(ArgAction::Help));
    if root {
        cmd = cmd
            .disable_version_flag(true)
            .arg(
                Arg::new("version")
                    .short('V')
                    .long("version")
                    .action(ArgAction::Version),
            )
            .about(pick(lang, HELP.about))
            .long_about(pick(lang, HELP.long_about))
            .after_help(pick(lang, HELP.after_help));
    } else if let Some((_, ru, enx)) = SUBCOMMANDS.iter().find(|(p, _, _)| *p == path) {
        cmd = cmd.about(if en { *enx } else { *ru }).long_about(None::<&str>);
    }
    cmd = cmd
        .help_template(format!(
            "{{before-help}}{{about-with-newline}}\n{usage} {{usage}}\n\n{{all-args}}{{after-help}}"
        ))
        .subcommand_help_heading(commands_h)
        .mut_args(|a| {
            let id = a.get_id().as_str().to_string();
            let a = match HELP.args.iter().find(|(k, _, _)| *k == id) {
                Some((_, ru, enx)) => {
                    let text = if en { *enx } else { *ru };
                    match env_name(&id) {
                        Some(var) => a.help(format!("{text} [{}: {var}]", if en { "env" } else { "переменная" })),
                        None => a.help(text),
                    }
                }
                None => a,
            };
            if a.is_positional() {
                a.help_heading(args_h)
            } else {
                a.help_heading(options_h)
            }
        });
    if !en {
        // clap writes the usage line with English placeholders; written out here instead.
        let mut usage_line = if root { "fcd".to_string() } else { format!("fcd {path}") };
        usage_line.push_str(" [ПАРАМЕТРЫ]");
        for p in cmd.get_positionals() {
            usage_line.push_str(&format!(
                " <{}>",
                p.get_value_names()
                    .and_then(|v| v.first())
                    .map_or("ЗНАЧЕНИЕ".to_string(), |v| v.to_string())
            ));
        }
        if cmd.has_subcommands() {
            usage_line.push_str(if cmd.is_subcommand_required_set() {
                " <КОМАНДА>"
            } else {
                " [КОМАНДА]"
            });
        }
        cmd = cmd.override_usage(usage_line);
    }
    let names: Vec<String> = cmd.get_subcommands().map(|c| c.get_name().to_string()).collect();
    for name in names {
        let full = if root { name.clone() } else { format!("{path} {name}") };
        cmd = cmd.mut_subcommand(&name, |sc| localize(sc, lang, &full));
    }
    cmd
}

/// The command line definition with help in `lang`.
pub fn command(lang: lang::Lang) -> clap::Command {
    localize(<Cli as clap::CommandFactory>::command(), lang, "")
}

/// Parses the arguments with help and errors in the current language.
pub fn parse_cli<I, T>(args: I) -> Result<Cli, clap::Error>
where
    I: IntoIterator<Item = T>,
    T: Into<std::ffi::OsString> + Clone,
{
    let mut matches = command(lang::current()).try_get_matches_from(args)?;
    <Cli as clap::FromArgMatches>::from_arg_matches_mut(&mut matches)
}

/// Prints a command-line error (or the help and version texts clap
/// reports the same way) in the current language and returns the exit
/// code. Clap words its errors in English only; the common ones are
/// written again in Russian here, the rest keep clap's English text.
pub fn report_cli_error(e: &clap::Error) -> i32 {
    use clap::error::{ContextKind, ContextValue, ErrorKind};
    let code = e.exit_code();
    if lang::current() == lang::Lang::En || matches!(e.kind(), ErrorKind::DisplayHelp | ErrorKind::DisplayVersion) {
        let _ = e.print();
        return code;
    }
    let ctx = |k: ContextKind| match e.get(k) {
        Some(ContextValue::String(s)) => s.clone(),
        Some(ContextValue::Strings(v)) => v.join(", "),
        Some(other) => other.to_string(),
        None => String::new(),
    };
    let text = match e.kind() {
        ErrorKind::UnknownArgument => format!("неизвестный параметр «{}»", ctx(ContextKind::InvalidArg)),
        ErrorKind::InvalidSubcommand => format!("неизвестная команда «{}»", ctx(ContextKind::InvalidSubcommand)),
        ErrorKind::InvalidValue | ErrorKind::ValueValidation => {
            let valid = ctx(ContextKind::ValidValue);
            let mut t = format!(
                "недопустимое значение «{}» для {}",
                ctx(ContextKind::InvalidValue),
                ctx(ContextKind::InvalidArg)
            );
            if !valid.is_empty() {
                t.push_str(&format!(" (можно: {valid})"));
            }
            t
        }
        ErrorKind::MissingRequiredArgument => {
            format!("не хватает обязательных параметров: {}", ctx(ContextKind::InvalidArg))
        }
        ErrorKind::ArgumentConflict => format!(
            "{} нельзя указывать вместе с {}",
            ctx(ContextKind::InvalidArg),
            ctx(ContextKind::PriorArg)
        ),
        ErrorKind::MissingSubcommand | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => {
            "не указана команда".to_string()
        }
        ErrorKind::TooManyValues | ErrorKind::WrongNumberOfValues | ErrorKind::TooFewValues => {
            format!("неверное число значений для {}", ctx(ContextKind::InvalidArg))
        }
        _ => {
            let _ = e.print();
            return code;
        }
    };
    eprintln!("ошибка: {text}\n\nПодробнее: fcd --help");
    code
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Without --family: replace the server admin code (creates families).
    /// With --family: a one-time recovery code of that family (stop the server first).
    ResetAdminCode {
        /// The family: an id from `fcd families list`, or `root`.
        #[arg(long, value_name = "ID")]
        family: Option<String>,
    },
    /// Manage administrators (stop the server first).
    #[command(subcommand)]
    Admin(AdminCommand),
    /// Families of this server.
    #[command(subcommand)]
    Families(FamiliesCommand),
    /// Check that the server on this machine answers; exit code 0 if it does, 1 if not.
    /// Reads the port from --port or <DIR>/config.toml; works while the server runs.
    Healthcheck {
        /// Broken families fail the check too.
        #[arg(long)]
        strict: bool,
    },
}

#[derive(Debug, Subcommand)]
pub enum AdminCommand {
    /// List members with their userId, name and role.
    List {
        /// The family (an id from `fcd families list`); the root family without it.
        #[arg(long, value_name = "ID")]
        family: Option<String>,
    },
    /// Make a member an administrator (userId from `fcd admin list`).
    Add {
        /// The member's userId (26 characters).
        user_id: String,
        /// The family (an id from `fcd families list`); the root family without it.
        #[arg(long, value_name = "ID")]
        family: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
pub enum FamiliesCommand {
    /// Id, name and state of every family (read only; works while the server runs).
    List,
}

impl Cli {
    fn overrides(&self) -> Overrides {
        Overrides {
            port: self.port,
            listen: self.listen.clone(),
            family_name: self.family_name.clone(),
            retention_days: self.retention_days,
            max_file_mb: self.max_file_mb,
            push: self.push,
            push_subject: self.push_subject.clone(),
            min_free_mb: self.min_free_mb,
            trust_forwarded_for: self.trust_forwarded_for,
            lang: self.lang.clone(),
            // An empty flag value turns loading by link off.
            telegram_bot_token: self.telegram_bot_token.clone(),
            telegram_bot_token_file: self.telegram_bot_token_file.clone(),
            telegram_api_url: self.telegram_api_url.clone(),
            telegram_api_allow_http: self.telegram_api_allow_http,
        }
    }
}

pub fn init_tracing() {
    use tracing_subscriber::filter::Targets;
    use tracing_subscriber::prelude::*;
    let filter: Targets = std::env::var("RUST_LOG")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| Targets::new().with_default(tracing::Level::INFO));
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer().with_target(false).with_ansi(
                std::io::IsTerminal::is_terminal(&std::io::stdout()) && std::env::var_os("NO_COLOR").is_none(),
            ),
        )
        .with(filter)
        .init();
}

/// Entry point used by `main`. Returns the process exit code.
pub async fn main_with(cli: Cli) -> i32 {
    if let Some(Command::Healthcheck { strict }) = cli.command {
        let addr = match healthcheck::target(cli.data.as_deref(), &cli.overrides()) {
            Ok(a) => a,
            Err(e) => {
                eprintln!("{}: {e}", lang::l("ошибка", "error"));
                return 1;
            }
        };
        return match healthcheck::check(addr).await {
            Ok(version) => {
                println!(
                    "{}",
                    tr!(
                        "fcd {version} отвечает на {addr}",
                        "fcd {version} is answering on {addr}"
                    )
                );
                // A broken extra family must not restart the container with all the others:
                // a warning, and a failure only with --strict.
                let broken: Vec<_> = cli
                    .data
                    .as_deref()
                    .map(|d| families::scan(d, ""))
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|l| Some((l.id?, l.broken?)))
                    .collect();
                for (id, why) in &broken {
                    eprintln!(
                        "{}",
                        tr!(
                            "предупреждение: семья {id} сломана: {why}",
                            "warning: family {id} is broken: {why}"
                        )
                    );
                }
                if strict && !broken.is_empty() { 1 } else { 0 }
            }
            Err(e) => {
                eprintln!("{}: {e}", lang::l("ошибка", "error"));
                1
            }
        };
    }

    let Some(data) = cli.data.clone() else {
        eprintln!(
            "{}",
            lang::l(
                "ошибка: укажите папку данных: fcd --data <DIR>",
                "error: give the data folder: fcd --data <DIR>"
            )
        );
        return 2;
    };

    if let Some(Command::Families(FamiliesCommand::List)) = &cli.command {
        // Read only, no lock: works while the server runs.
        if !data.join(datadir::SERVER_FILE).is_file() {
            eprintln!(
                "{}: {}",
                lang::l("ошибка", "error"),
                tr!("{} не папка данных fcd", "{} is not a fcd data folder", data.display())
            );
            return 1;
        }
        let root_name = config::read_config_file(&data.join(datadir::CONFIG_FILE))
            .ok()
            .and_then(|o| o.family_name)
            .unwrap_or_else(|| config::default_family_name().to_string());
        for l in families::scan(&data, &root_name) {
            let id = l.id.as_deref().unwrap_or("root");
            let name = l.name.as_deref().unwrap_or(lang::l("(без имени)", "(no name)"));
            let state = match &l.broken {
                Some(why) => tr!("сломана: {why}", "broken: {why}"),
                None if l.set_up => lang::l("настроена", "set up").to_string(),
                None => lang::l("не настроена", "not set up").to_string(),
            };
            println!("{id}  {name}  [{state}]");
        }
        return 0;
    }

    let fail = |e: &dyn std::fmt::Display| {
        eprintln!("{}: {e}", lang::l("ошибка", "error"));
        1
    };

    if let Some(Command::Admin(AdminCommand::List { family })) = &cli.command {
        return match open_for_cli(&data, family.as_deref()) {
            Ok((_root, dir)) => {
                let members = dir.list_members();
                if members.is_empty() {
                    println!("{}", lang::l("участников пока нет", "no members yet"));
                }
                for m in members {
                    let mut flags = Vec::new();
                    if m.admin {
                        flags.push(lang::l("администратор", "administrator"));
                    }
                    if m.removed {
                        flags.push(lang::l("отключён", "removed"));
                    }
                    if m.revoked {
                        flags.push(lang::l("ключ отозван", "key revoked"));
                    }
                    let name = m.name.as_deref().unwrap_or(lang::l("(без имени)", "(no name)"));
                    if flags.is_empty() {
                        println!("{}  {name}", m.user_id);
                    } else {
                        println!("{}  {name}  [{}]", m.user_id, flags.join(", "));
                    }
                }
                0
            }
            Err(e) => fail(&e),
        };
    }

    if let Some(Command::Admin(AdminCommand::Add { user_id, family })) = &cli.command {
        return match open_for_cli(&data, family.as_deref()).and_then(|(_root, mut dir)| dir.add_admin(user_id)) {
            Ok(true) => {
                println!(
                    "{}",
                    tr!("{user_id} теперь администратор", "{user_id} is now an administrator")
                );
                0
            }
            Ok(false) => {
                println!(
                    "{}",
                    tr!("{user_id} уже администратор", "{user_id} is already an administrator")
                );
                0
            }
            Err(e) => fail(&e),
        };
    }

    if let Some(Command::ResetAdminCode { family }) = &cli.command {
        return match family {
            None => match DataDir::open(&data, Overrides::default()).and_then(|(mut dir, _)| dir.reset_admin_code()) {
                Ok(code) => {
                    println!(
                        "{}",
                        tr!(
                            "Новый код администратора сервера: {code}",
                            "New server admin code: {code}"
                        )
                    );
                    println!(
                        "{}",
                        lang::l(
                            "Код многоразовый и только создаёт семьи (в приложении: «Настроить для своей семьи»); \
                             старый больше не действует. Храните его как пароль.",
                            "The code is reusable and only creates families (in the app: “Set up for my family”); \
                             the old one no longer works. Keep it like a password."
                        )
                    );
                    0
                }
                Err(e) => fail(&e),
            },
            Some(f) => match open_for_cli(&data, Some(f)).and_then(|(_root, mut dir)| dir.reset_join_code()) {
                Ok(code) => {
                    println!(
                        "{}",
                        tr!(
                            "Код восстановления семьи {f}: {code}",
                            "Recovery code of family {f}: {code}"
                        )
                    );
                    println!(
                        "{}",
                        lang::l(
                            "Одноразовый: кто войдёт с ним в эту семью как администратор, станет администратором \
                             (участник семьи тоже).",
                            "One-time: whoever joins this family with it as an administrator becomes one \
                             (a member of the family too)."
                        )
                    );
                    0
                }
                Err(e) => fail(&e),
            },
        };
    }

    let (dir, settings) = match DataDir::open(&data, cli.overrides()) {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("{e}");
            return 1;
        }
    };

    let assets = match &cli.web_dir {
        Some(p) if !p.join("index.html").is_file() => {
            tracing::error!(
                "{}",
                tr!(
                    "в --web-dir {} нет index.html",
                    "--web-dir {} has no index.html",
                    p.display()
                )
            );
            return 1;
        }
        Some(p) => Assets::Dir(p.clone()),
        None => Assets::Embedded,
    };

    let tls = match (&cli.tls_cert, &cli.tls_key) {
        (Some(c), Some(k)) => match tls::load_config(c, k) {
            Ok(cfg) => Some(cfg),
            Err(e) => {
                tracing::error!("{e}");
                return 1;
            }
        },
        _ => None,
    };

    let listener = match tokio::net::TcpListener::bind(settings.listen).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(
                "{}",
                tr!(
                    "не удалось занять адрес {}: {e}",
                    "could not bind to {}: {e}",
                    settings.listen
                )
            );
            return 1;
        }
    };
    let local = listener.local_addr().unwrap_or(settings.listen);

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let common = app::Common::new(settings.clone(), assets, shutdown_rx);
    let fams = match families::Families::start(&dir, common) {
        Ok(f) => f,
        Err(e) => {
            tracing::error!("{e}");
            return 1;
        }
    };
    let state = fams.root().clone();
    match &state.telegram {
        Some(tg) => tg.spawn_check(),
        None => tracing::info!(
            "{}",
            lang::l(
                "Загрузка стикеров из Telegram: выключена (нет токена бота)",
                "Loading stickers from Telegram: off (no bot token)"
            )
        ),
    }

    tracing::info!(
        "{}",
        tr!(
            "fcd {}, папка данных {}",
            "fcd {}, data folder {}",
            VERSION_LINE,
            dir.path.display()
        )
    );
    let push = if settings.push {
        lang::l("включён", "on")
    } else {
        lang::l("выключен", "off")
    };
    tracing::info!(
        "{}",
        tr!(
            "семья «{}», срок хранения {} дн., предел файла {} МБ, push {}, язык {}",
            "family “{}”, retention {} days, file limit {} MB, push {}, language {}",
            settings.family_name,
            settings.retention_days,
            settings.max_file_mb,
            push,
            lang::current().code()
        )
    );
    if let Some(p) = &cli.web_dir {
        tracing::info!(
            "{}",
            tr!(
                "клиент отдаётся из папки {}",
                "serving the web client from {}",
                p.display()
            )
        );
    }
    let (members, events) = state
        .store
        .read(|m| (m.users.values().filter(|u| u.removed_at.is_none()).count(), m.log.len()));
    tracing::info!(
        "{}",
        tr!(
            "участников {members}, событий в журнале {events}",
            "{members} members, {events} events in the log"
        )
    );
    let (extra, broken) = fams.summary();
    if extra > 0 {
        tracing::info!(
            "{}",
            tr!(
                "других семей на этом сервере: {extra} (список: fcd families list)",
                "other families on this server: {extra} (list: fcd families list)"
            )
        );
    }
    for (id, why) in broken {
        tracing::warn!(
            "{}",
            tr!(
                "семья {id} сломана и отвечает 503: {why}; см. docs/ADMIN.md",
                "family {id} is broken and answers 503: {why}; see docs/ADMIN.md"
            )
        );
    }
    let scheme = if tls.is_some() { "https" } else { "http" };
    tracing::info!(
        "{}",
        tr!(
            "слушаю {local} ({})",
            "listening on {local} ({})",
            scheme.to_uppercase()
        )
    );
    for url in browse_urls(scheme, local) {
        tracing::info!("{}", tr!("откройте {url}", "open {url}"));
    }
    if tls.is_none() {
        tracing::info!(
            "{}",
            lang::l(
                "приложению нужен HTTPS (без него работает только http://localhost на этом компьютере): \
                 обратный прокси (Caddy, nginx, роутер, NAS) или --tls-cert и --tls-key",
                "the app needs HTTPS (without it only http://localhost works, on this computer): \
                 a reverse proxy (Caddy, nginx, a router, a NAS) or --tls-cert and --tls-key"
            )
        );
    }
    if let Some(code) = &dir.new_admin_code {
        // The only time the code is logged.
        tracing::info!(
            "{}",
            lang::l(
                "первый запуск: папка данных создана",
                "first start: the data folder was created"
            )
        );
        tracing::info!(
            "{}",
            tr!("код администратора сервера: {code}", "server admin code: {code}")
        );
        tracing::info!(
            "{}",
            lang::l(
                "дальше: откройте приложение, нажмите «Настроить для своей семьи» и введите этот код",
                "next: open the app, tap “Set up for my family” and enter this code"
            )
        );
        tracing::info!(
            "{}",
            lang::l(
                "код многоразовый: им же создают другие семьи на этом сервере; храните его как пароль. \
                 Показывается один раз; новый: fcd reset-admin-code --data <DIR> при остановленном сервере",
                "the code is reusable: it also creates other families on this server; keep it like a password. \
                 It is shown once; a new one: fcd reset-admin-code --data <DIR> with the server stopped"
            )
        );
    }
    drop(state);

    let app = families::router(fams);
    let result = match tls {
        Some(cfg) => match tls::TlsListener::new(listener, cfg) {
            // `tap_io` gives the listener axum's `ConnectInfo<SocketAddr>`.
            Ok(l) => run(axum::serve::ListenerExt::tap_io(l, |_| {}), app, shutdown_tx).await,
            Err(e) => Err(e),
        },
        None => run(listener, app, shutdown_tx).await,
    };
    drop(dir);
    match result {
        Ok(()) => {
            tracing::info!("{}", lang::l("остановлен", "stopped"));
            0
        }
        Err(e) => {
            tracing::error!("{}", tr!("ошибка сервера: {e}", "server error: {e}"));
            1
        }
    }
}

/// Opens the data folder (with its lock) for a command about one family:
/// the root one without `family` or with `root`, else `families/<id>`. The
/// root folder is returned too: it holds the lock while the family is used.
fn open_for_cli(
    data: &std::path::Path,
    family: Option<&str>,
) -> Result<(Option<DataDir>, DataDir), datadir::OpenError> {
    let (root, _) = DataDir::open(data, Overrides::default())?;
    match family {
        None | Some("root") => Ok((None, root)),
        Some(id) => {
            if !datadir::valid_family_id(id) || !root.path.join(datadir::FAMILIES_DIR).join(id).is_dir() {
                return Err(datadir::OpenError::Config(tr!(
                    "семья {id} не найдена в папке данных {}; список: fcd families list",
                    "family {id} not found in the data folder {}; list: fcd families list",
                    root.path.display()
                )));
            }
            let dir = DataDir::open_family(&root.path, id, root.vapid.clone())?;
            Ok((Some(root), dir))
        }
    }
}

/// Serves until a shutdown signal, then waits for open requests at most
/// [`SHUTDOWN_GRACE`].
async fn run<L>(listener: L, app: axum::Router, shutdown_tx: watch::Sender<bool>) -> std::io::Result<()>
where
    L: axum::serve::Listener<Addr = SocketAddr>,
    SocketAddr: for<'a> axum::extract::connect_info::Connected<axum::serve::IncomingStream<'a, L>>,
{
    let mut stopping = shutdown_tx.subscribe();
    let server = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).with_graceful_shutdown(
        async move {
            shutdown_signal().await;
            tracing::info!(
                "{}",
                lang::l(
                    "получен сигнал завершения, останавливаюсь",
                    "got a stop signal, stopping"
                )
            );
            let _ = shutdown_tx.send(true);
        },
    );
    tokio::select! {
        r = std::future::IntoFuture::into_future(server) => r,
        _ = async {
            let _ = stopping.wait_for(|v| *v).await;
            tokio::time::sleep(SHUTDOWN_GRACE).await;
        } => {
            tracing::warn!(
                "{}",
                tr!("соединения не закрылись за {} с, завершаюсь", "connections did not close within {} s, exiting", SHUTDOWN_GRACE.as_secs())
            );
            Ok(())
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    // Windows: closing the console window, logging off or shutting down.
    #[cfg(windows)]
    let term = async {
        use tokio::signal::windows;
        match (windows::ctrl_close(), windows::ctrl_shutdown(), windows::ctrl_logoff()) {
            (Ok(mut close), Ok(mut shutdown), Ok(mut logoff)) => {
                tokio::select! {
                    _ = close.recv() => {}
                    _ = shutdown.recv() => {}
                    _ = logoff.recv() => {}
                }
            }
            _ => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(any(unix, windows)))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = term => {}
    }
}

/// Addresses to print for the owner: the app and the check page `/server/`.
/// For `0.0.0.0` the LAN address is found with a connected UDP socket (no
/// packet is sent).
fn browse_urls(scheme: &str, local: SocketAddr) -> Vec<String> {
    let port = local.port();
    let base = if local.ip().is_unspecified() {
        lan_ip().map_or_else(
            || format!("localhost:{port}"),
            |ip| SocketAddr::new(ip, port).to_string(),
        )
    } else {
        local.to_string()
    };
    vec![
        format!("{scheme}://{base}/ ({})", lang::l("приложение", "the app")),
        format!(
            "{scheme}://{base}/server/ ({})",
            lang::l("проверка сервера", "server check")
        ),
    ]
}

fn lan_ip() -> Option<IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_unspecified() && !ip.is_loopback()).then_some(ip)
}

/// Graceful shutdown waits for open requests; long requests end on the
/// shutdown signal, and nothing is allowed to keep the process longer than this.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);

#[cfg(test)]
mod cli_tests {
    use super::*;
    use std::path::Path;

    fn env(pairs: &[(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> + use<> {
        let pairs: Vec<(&'static str, &'static str)> = pairs.to_vec();
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
    }

    fn cli(args: &[&str], vars: &[(&'static str, &'static str)]) -> Result<Cli, String> {
        let mut c = parse_cli(std::iter::once("fcd").chain(args.iter().copied())).map_err(|e| e.to_string())?;
        c.apply_env(env(vars))?;
        Ok(c)
    }

    #[test]
    fn every_variable_is_read() {
        let c = cli(
            &[],
            &[
                ("FCD_DATA", "/srv/fc"),
                ("FCD_PORT", "8080"),
                ("FCD_LISTEN", "127.0.0.1"),
                ("FCD_FAMILY_NAME", "Ивановы"),
                ("FCD_RETENTION_DAYS", "30"),
                ("FCD_MAX_FILE_MB", "50"),
                ("FCD_PUSH", "0"),
                ("FCD_TRUST_FORWARDED_FOR", "TRUE"),
                ("FCD_PUSH_SUBJECT", "mailto:me@example.com"),
                ("FCD_MIN_FREE_MB", "0"),
                ("FCD_WEB_DIR", "/w"),
                ("FCD_TLS_CERT", "/c.pem"),
                ("FCD_TLS_KEY", "/k.pem"),
                ("FCD_LANG", "en"),
            ],
        )
        .unwrap();
        assert_eq!(c.data.as_deref(), Some(Path::new("/srv/fc")));
        assert_eq!(c.port, Some(8080));
        assert_eq!(c.listen.as_deref(), Some("127.0.0.1"));
        assert_eq!(c.family_name.as_deref(), Some("Ивановы"));
        assert_eq!(c.retention_days, Some(30));
        assert_eq!(c.max_file_mb, Some(50));
        assert_eq!(c.push, Some(false));
        assert_eq!(c.trust_forwarded_for, Some(true));
        assert_eq!(c.push_subject.as_deref(), Some("mailto:me@example.com"));
        assert_eq!(c.min_free_mb, Some(0));
        let o = c.overrides();
        assert_eq!(o.push_subject.as_deref(), Some("mailto:me@example.com"));
        assert_eq!(o.min_free_mb, Some(0));
        assert_eq!(c.web_dir.as_deref(), Some(Path::new("/w")));
        assert_eq!(c.tls_cert.as_deref(), Some(Path::new("/c.pem")));
        assert_eq!(c.tls_key.as_deref(), Some(Path::new("/k.pem")));
        assert_eq!(c.lang.as_deref(), Some("en"));
        // Every option of the command line has a variable.
        let cmd = command(lang::Lang::Ru);
        for a in cmd
            .get_arguments()
            .filter(|a| !matches!(a.get_id().as_str(), "help" | "version"))
        {
            assert!(
                env_name(a.get_id().as_str()).is_some(),
                "{} has no variable",
                a.get_id()
            );
        }
    }

    #[test]
    fn flag_wins_over_variable_and_empty_variables_do_not_count() {
        let c = cli(
            &["--port", "1", "--push", "true"],
            &[("FCD_PORT", "2"), ("FCD_PUSH", "false"), ("FCD_LISTEN", "  ")],
        )
        .unwrap();
        assert_eq!(c.port, Some(1));
        assert_eq!(c.push, Some(true));
        assert_eq!(c.listen, None);
        // Flags accept 1 and 0 too.
        assert_eq!(cli(&["--push", "0"], &[]).unwrap().push, Some(false));
    }

    #[test]
    fn precedence_flag_variable_config_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.toml"), "port = 1111\nlisten = \"127.0.0.1\"\n").unwrap();
        let d = dir.path().to_str().unwrap();
        let port = |args: &[&str], vars: &[(&'static str, &'static str)]| {
            let c = cli(args, vars).unwrap();
            healthcheck::target(c.data.as_deref(), &c.overrides()).unwrap().port()
        };
        assert_eq!(port(&["--data", d, "--port", "3333"], &[("FCD_PORT", "2222")]), 3333);
        assert_eq!(port(&["--data", d], &[("FCD_PORT", "2222")]), 2222);
        assert_eq!(port(&["--data", d], &[]), 1111);
        assert_eq!(port(&[], &[]), config::DEFAULT_PORT);
        // The folder itself can come from the environment.
        assert_eq!(port(&[], &[("FCD_DATA", "")]), config::DEFAULT_PORT);
        let leaked: &'static str = Box::leak(d.to_string().into_boxed_str());
        assert_eq!(port(&[], &[("FCD_DATA", leaked)]), 1111);
    }

    #[test]
    fn invalid_values_name_the_variable() {
        for (var, value) in [
            ("FCD_PORT", "eighty"),
            ("FCD_PUSH", "yes"),
            ("FCD_MIN_FREE_MB", "lots"),
            ("FCD_PUSH_SUBJECT", "me@example.com"),
            ("FCD_RETENTION_DAYS", "-1"),
            ("FCD_LANG", "de"),
        ] {
            let e = cli(&[], &[(var, value)]).unwrap_err();
            assert!(e.contains(var) && e.contains(value), "{e}");
        }
        let e = cli(&[], &[("FCD_TLS_CERT", "/c.pem")]).unwrap_err();
        assert!(e.contains("FCD_TLS_KEY"), "{e}");
    }

    #[test]
    fn new_flags_win_over_variables() {
        let c = cli(
            &["--push-subject", "https://example.com/c", "--min-free-mb", "5"],
            &[("FCD_PUSH_SUBJECT", "mailto:x@example.com"), ("FCD_MIN_FREE_MB", "7")],
        )
        .unwrap();
        assert_eq!(c.push_subject.as_deref(), Some("https://example.com/c"));
        assert_eq!(c.min_free_mb, Some(5));
        // A bad flag value names the flag and the value.
        let e = cli(&["--push-subject", "me@example.com"], &[]).unwrap_err();
        assert!(e.contains("--push-subject") && e.contains("me@example.com"), "{e}");
    }

    #[test]
    fn unrelated_fcd_variables_are_ignored() {
        let c = cli(
            &[],
            &[("FCD_GIT_COMMIT", "abc"), ("FCD_BIN", "/x"), ("FCD_SOMETHING", "?")],
        )
        .unwrap();
        assert_eq!(c.port, None);
        assert_eq!(c.data, None);
    }

    #[test]
    fn help_names_the_variables() {
        let help = command(lang::Lang::Ru).render_long_help().to_string();
        for (_, var) in ENV_VARS {
            assert!(help.contains(var), "{var} missing in help");
        }
        assert!(
            help.contains("Использование:") && help.contains("переменная: FCD_PORT"),
            "{help}"
        );
        let en = command(lang::Lang::En).render_long_help().to_string();
        assert!(
            en.contains("Usage:") && en.contains("env: FCD_PORT") && en.contains("Data folder"),
            "{en}"
        );
        assert!(
            !en.chars().any(|c| ('а'..='я').contains(&c.to_ascii_lowercase())),
            "{en}"
        );
    }
}
