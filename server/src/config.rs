//! Settings: command-line flags override `config.toml`, which overrides defaults.

use std::net::{IpAddr, SocketAddr};
use std::path::Path;

use serde::Deserialize;

pub const DEFAULT_PORT: u16 = 8787;
pub const DEFAULT_LISTEN: &str = "0.0.0.0";
/// Family name when none is given: in the server's language at first start.
pub fn default_family_name() -> &'static str {
    crate::lang::l("Семья", "Family")
}
pub const DEFAULT_RETENTION_DAYS: u32 = 90;
pub const DEFAULT_MAX_FILE_MB: u64 = 200;
/// Below this much free space on the data disk the server answers 507.
pub const DEFAULT_MIN_FREE_MB: u64 = 100;
/// RFC 8292 `sub` claim. Apple requires a real-looking contact.
/// Neutral placeholder: the subject is sent to third-party push services, so the default must not identify anyone.
pub const DEFAULT_PUSH_SUBJECT: &str = "mailto:fcd-admin@example.org";

/// Default address of the Telegram Bot API.
pub const DEFAULT_TELEGRAM_API_URL: &str = "https://api.telegram.org";

/// A secret value (the Telegram bot token): `Debug` and `Display` print `***`,
/// so it never reaches a log line or an error message by accident.
#[derive(Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(v: impl Into<String>) -> Secret {
        Secret(v.into())
    }

    /// The value itself, only for building the request to Telegram.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.trim().is_empty()
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("***")
    }
}

impl std::fmt::Display for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("***")
    }
}

/// Optional values, as read from `config.toml` or from flags.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Overrides {
    pub port: Option<u16>,
    pub listen: Option<String>,
    pub family_name: Option<String>,
    pub retention_days: Option<u32>,
    pub max_file_mb: Option<u64>,
    pub push: Option<bool>,
    pub push_subject: Option<String>,
    pub min_free_mb: Option<u64>,
    pub trust_forwarded_for: Option<bool>,
    /// Offer family setup on the first screen even when a family exists.
    pub offer_setup: Option<bool>,
    /// Language of the console output, `ru` or `en` (only in the file; the flag is `--lang`).
    pub lang: Option<String>,
    /// Bot token for loading Telegram sticker sets by link (secret).
    pub telegram_bot_token: Option<Secret>,
    /// A file with the bot token (Docker and Podman secrets).
    pub telegram_bot_token_file: Option<String>,
    /// Bot API address (own telegram-bot-api, or a fake one in tests).
    pub telegram_api_url: Option<String>,
    /// Allow `http://` for the Bot API address beyond loopback.
    pub telegram_api_allow_http: Option<bool>,
}

impl Overrides {
    /// `self` wins over `lower`.
    pub fn or(self, lower: Overrides) -> Overrides {
        Overrides {
            port: self.port.or(lower.port),
            listen: self.listen.or(lower.listen),
            family_name: self.family_name.or(lower.family_name),
            retention_days: self.retention_days.or(lower.retention_days),
            max_file_mb: self.max_file_mb.or(lower.max_file_mb),
            push: self.push.or(lower.push),
            push_subject: self.push_subject.or(lower.push_subject),
            min_free_mb: self.min_free_mb.or(lower.min_free_mb),
            trust_forwarded_for: self.trust_forwarded_for.or(lower.trust_forwarded_for),
            offer_setup: self.offer_setup.or(lower.offer_setup),
            lang: self.lang.or(lower.lang),
            telegram_bot_token: self.telegram_bot_token.or(lower.telegram_bot_token),
            telegram_bot_token_file: self.telegram_bot_token_file.or(lower.telegram_bot_token_file),
            telegram_api_url: self.telegram_api_url.or(lower.telegram_api_url),
            telegram_api_allow_http: self.telegram_api_allow_http.or(lower.telegram_api_allow_http),
        }
    }
}

/// Loading Telegram sticker sets by link: the bot token and the Bot API address.
#[derive(Debug, Clone)]
pub struct TelegramSettings {
    pub token: Secret,
    /// Without a trailing slash, for example `https://api.telegram.org`.
    pub api_url: String,
}

/// Effective settings.
#[derive(Debug, Clone)]
pub struct Settings {
    pub listen: SocketAddr,
    pub family_name: String,
    pub retention_days: u32,
    pub max_file_mb: u64,
    pub push: bool,
    pub push_subject: String,
    pub min_free_mb: u64,
    /// Take the client address for rate limiting from `X-Forwarded-For`
    /// (only behind a reverse proxy that sets it).
    pub trust_forwarded_for: bool,
    /// The web app offers family setup even when this server has its family
    /// (to set up a family on another server). Still one family per server.
    pub offer_setup: bool,
    /// `None`: no bot token, loading sticker sets by link is off.
    pub telegram: Option<TelegramSettings>,
}

/// Where the bot token can come from, for error messages (never the value).
const TOKEN_SOURCES: (&str, &str) = (
    "токен бота Telegram (--telegram-bot-token, FCD_TELEGRAM_BOT_TOKEN или telegram_bot_token в config.toml)",
    "the Telegram bot token (--telegram-bot-token, FCD_TELEGRAM_BOT_TOKEN or telegram_bot_token in config.toml)",
);

/// A bot token looks like `123456:ABC-def_ghi`.
fn token_well_formed(t: &str) -> bool {
    let Some((id, rest)) = t.split_once(':') else {
        return false;
    };
    !id.is_empty()
        && id.len() <= 20
        && id.bytes().all(|b| b.is_ascii_digit())
        && (20..=100).contains(&rest.len())
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The token from its sources: the value wins over the file. Errors name the
/// source, never the value.
fn resolve_telegram(o: &Overrides) -> Result<Option<TelegramSettings>, String> {
    let token = match (&o.telegram_bot_token, &o.telegram_bot_token_file) {
        (Some(t), _) => t.clone(),
        (None, Some(path)) if !path.trim().is_empty() => {
            let text = std::fs::read_to_string(path.trim()).map_err(|e| {
                tr!(
                    "файл с токеном бота Telegram (--telegram-bot-token-file, FCD_TELEGRAM_BOT_TOKEN_FILE или \
                     telegram_bot_token_file в config.toml) {}: не удалось прочитать: {}",
                    "the Telegram bot token file (--telegram-bot-token-file, FCD_TELEGRAM_BOT_TOKEN_FILE or \
                     telegram_bot_token_file in config.toml) {}: could not read it: {}",
                    path.trim(),
                    e.kind()
                )
            })?;
            Secret::new(text.trim().to_string())
        }
        _ => Secret::default(),
    };
    let token = Secret::new(token.expose().trim().to_string());
    let api_url = o
        .telegram_api_url
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(DEFAULT_TELEGRAM_API_URL)
        .trim_end_matches('/')
        .to_string();
    check_api_url(&api_url, o.telegram_api_allow_http.unwrap_or(false))?;
    if token.is_empty() {
        return Ok(None);
    }
    if !token_well_formed(token.expose()) {
        return Err(tr!(
            "{}: не похож на токен бота (число, двоеточие и не меньше 20 букв, цифр, _ или -)",
            "{}: does not look like a bot token (a number, a colon and at least 20 letters, digits, _ or -)",
            crate::lang::l(TOKEN_SOURCES.0, TOKEN_SOURCES.1)
        ));
    }
    Ok(Some(TelegramSettings { token, api_url }))
}

/// `https://host[:port][/path]`, or `http://` on loopback or with `allow_http`.
fn check_api_url(url: &str, allow_http: bool) -> Result<(), String> {
    let bad = |why: &str| {
        tr!(
            "адрес Bot API (--telegram-api-url, FCD_TELEGRAM_API_URL или telegram_api_url в config.toml) «{url}»: {why}",
            "the Bot API address (--telegram-api-url, FCD_TELEGRAM_API_URL or telegram_api_url in config.toml) “{url}”: {why}"
        )
    };
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| bad(crate::lang::l("нужен https://адрес", "expected https://address")))?;
    let host_port = rest.split('/').next().unwrap_or("");
    if host_port.is_empty() || rest.contains(['?', '#', '@']) {
        return Err(bad(crate::lang::l("нужен https://адрес", "expected https://address")));
    }
    if url.parse::<hyper::Uri>().is_err() {
        return Err(bad(crate::lang::l("это не адрес", "not an address")));
    }
    match scheme {
        "https" => Ok(()),
        "http" => {
            let host = host_port.rsplit_once(':').map_or(host_port, |(h, _)| h);
            if allow_http || matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
                Ok(())
            } else {
                Err(bad(crate::lang::l(
                    "http:// разрешён только для 127.0.0.1 и localhost или с --telegram-api-allow-http",
                    "http:// is allowed only for 127.0.0.1 and localhost or with --telegram-api-allow-http",
                )))
            }
        }
        _ => Err(bad(crate::lang::l("нужен https://адрес", "expected https://address"))),
    }
}

impl Settings {
    pub fn resolve(o: Overrides) -> Result<Settings, String> {
        let telegram = resolve_telegram(&o)?;
        let ip: IpAddr = o.listen.as_deref().unwrap_or(DEFAULT_LISTEN).parse().map_err(|_| {
            crate::lang::l(
                "адрес прослушивания (listen) должен быть IP-адресом, например 0.0.0.0",
                "the listen address (listen) must be an IP address, for example 0.0.0.0",
            )
            .to_string()
        })?;
        let retention_days = o.retention_days.unwrap_or(DEFAULT_RETENTION_DAYS);
        if !(7..=90).contains(&retention_days) {
            return Err(tr!(
                "срок хранения (retention_days) должен быть от 7 до 90 дней, указано {retention_days}",
                "retention (retention_days) must be 7 to 90 days, got {retention_days}"
            ));
        }
        let max_file_mb = o.max_file_mb.unwrap_or(DEFAULT_MAX_FILE_MB);
        if max_file_mb == 0 {
            return Err(crate::lang::l(
                "предел файла (max_file_mb) должен быть больше нуля",
                "the file limit (max_file_mb) must be more than zero",
            )
            .into());
        }
        let family_name = o
            .family_name
            .unwrap_or_else(|| default_family_name().into())
            .trim()
            .to_string();
        if family_name.is_empty() || family_name.chars().count() > 100 {
            return Err(crate::lang::l(
                "имя семьи (family_name) должно быть от 1 до 100 символов",
                "the family name (family_name) must be 1 to 100 characters",
            )
            .into());
        }
        let push_subject = o.push_subject.unwrap_or_else(|| DEFAULT_PUSH_SUBJECT.into());
        // Flags and variables are checked when parsed, so a bad value here comes from the file.
        if !(push_subject.starts_with("mailto:") || push_subject.starts_with("https://")) {
            return Err(tr!(
                "push_subject в config.toml: недопустимое значение «{push_subject}»: нужно mailto: или https://",
                "push_subject in config.toml: invalid value “{push_subject}”: expected mailto: or https://"
            ));
        }
        if let Some(l) = o.lang.as_deref()
            && crate::lang::Lang::parse(l).is_none_or(|p| p.code() != l)
        {
            return Err(crate::lang::l(
                "язык (lang) должен быть ru или en",
                "the language (lang) must be ru or en",
            )
            .into());
        }
        Ok(Settings {
            telegram,
            listen: SocketAddr::new(ip, o.port.unwrap_or(DEFAULT_PORT)),
            family_name,
            retention_days,
            max_file_mb,
            push: o.push.unwrap_or(true),
            push_subject,
            min_free_mb: o.min_free_mb.unwrap_or(DEFAULT_MIN_FREE_MB),
            trust_forwarded_for: o.trust_forwarded_for.unwrap_or(false),
            offer_setup: o.offer_setup.unwrap_or(false),
        })
    }
}

pub fn read_config_file(path: &Path) -> Result<Overrides, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => toml::from_str(&text).map_err(|e| toml_error(path, &text, &e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Overrides::default()),
        Err(e) => Err(tr!(
            "не удалось прочитать {}: {e}",
            "could not read {}: {e}",
            path.display()
        )),
    }
}

/// A TOML error with the line number and the message, without the source
/// text: the line may hold the bot token.
pub fn toml_error(path: &Path, text: &str, e: &toml::de::Error) -> String {
    let line = e
        .span()
        .map(|s| text[..s.start.min(text.len())].matches('\n').count() + 1);
    let msg = e.message().trim();
    match line {
        Some(n) => tr!(
            "ошибка в {}, строка {n}: {msg}",
            "error in {}, line {n}: {msg}",
            path.display()
        ),
        None => tr!("ошибка в {}: {msg}", "error in {}: {msg}", path.display()),
    }
}

/// Text of `config.toml` written at first start, with the effective values,
/// commented in the server's language.
pub fn config_template(s: &Settings) -> String {
    let family = toml::Value::String(s.family_name.clone()).to_string();
    let offer_setup = s.offer_setup;
    let (port, ip, retention, max_file, push, min_free, trust_xff) = (
        s.listen.port(),
        s.listen.ip(),
        s.retention_days,
        s.max_file_mb,
        s.push,
        s.min_free_mb,
        s.trust_forwarded_for,
    );
    tr!(
        r#"# Настройки fcd. Флаги командной строки важнее значений из этого файла.
# После правки перезапустите сервер.

# Порт и адрес, на которых сервер слушает HTTP.
port = {port}
listen = "{ip}"

# Имя семьи, его видят все участники.
family_name = {family}

# Срок хранения переписки на сервере, дней (от 7 до 90).
retention_days = {retention}

# Предел размера одного файла, МБ.
max_file_mb = {max_file}

# Уведомления Web Push. false: сервер не обращается ни к каким внешним адресам.
push = {push}

# Контакт для push-сервисов (RFC 8292): mailto:адрес или https://адрес.
# push_subject = "mailto:you@example.com"

# Если свободного места на диске меньше этого, МБ, сервер не принимает новые сообщения.
min_free_mb = {min_free}

# true: адрес клиента для ограничения частоты неверных кодов берётся из заголовка
# X-Forwarded-For. Включайте, только если сервер стоит за обратным прокси,
# который этот заголовок выставляет; иначе его может подделать кто угодно.
trust_forwarded_for = {trust_xff}

# true: первый экран веб-приложения предлагает «Настроить для своей семьи», даже когда
# семья на этом сервере уже есть, чтобы настроить семью на другом сервере.
# Сервер по-прежнему держит одну семью.
offer_setup = {offer_setup}

# Токен бота Telegram для загрузки наборов стикеров по ссылке t.me/addstickers/…
# (получить у @BotFather, см. docs/ADMIN.md#telegram). Пусто: загрузка по ссылке выключена.
# С токеном сервер обращается к api.telegram.org. Токен — секрет, как пароль.
# telegram_bot_token = ""

# Язык сообщений сервера: "ru" или "en". Без этой строки: флаг --lang,
# затем переменные LC_ALL, LC_MESSAGES, LANG, иначе русский.
# lang = "ru"
"#,
        r#"# fcd settings. Command-line flags win over the values in this file.
# Restart the server after editing it.

# Port and address the server listens on for HTTP.
port = {port}
listen = "{ip}"

# Family name, everyone in the family sees it.
family_name = {family}

# How long the server keeps messages, days (7 to 90).
retention_days = {retention}

# Size limit of one file, MB.
max_file_mb = {max_file}

# Web Push notifications. false: the server never contacts any outside address.
push = {push}

# Contact for push services (RFC 8292): mailto:address or https://address.
# push_subject = "mailto:you@example.com"

# Below this much free disk space, MB, the server refuses new messages.
min_free_mb = {min_free}

# true: the client address for rate limiting wrong codes is taken from the
# X-Forwarded-For header. Only turn it on behind a reverse proxy that sets
# this header; otherwise anyone can fake it.
trust_forwarded_for = {trust_xff}

# true: the web app's first screen offers "Set up for my family" even when this
# server already has its family, to set up a family on another server.
# The server still holds one family.
offer_setup = {offer_setup}

# Telegram bot token for loading sticker sets by link t.me/addstickers/…
# (get one from @BotFather, see docs/ADMIN.md#telegram). Empty: loading by link is off.
# With a token the server contacts api.telegram.org. The token is a secret, like a password.
# telegram_bot_token = ""

# Language of the server's messages: "ru" or "en". Without this line: the
# --lang flag, then the LC_ALL, LC_MESSAGES, LANG variables, else Russian.
# lang = "en"
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_round_trips() {
        let s = Settings::resolve(Overrides {
            family_name: Some("Ивановы \"и\" ко".into()),
            ..Default::default()
        })
        .unwrap();
        let back: Overrides = toml::from_str(&config_template(&s)).unwrap();
        let s2 = Settings::resolve(back).unwrap();
        assert_eq!(s2.family_name, s.family_name);
        assert_eq!(s2.listen, s.listen);
        assert_eq!(s2.retention_days, 90);
        assert!(s2.push);
        assert_eq!(s2.min_free_mb, DEFAULT_MIN_FREE_MB);
        assert!(!s2.trust_forwarded_for);
    }

    #[test]
    fn lang_is_ru_or_en() {
        for (v, ok) in [
            ("ru", true),
            ("en", true),
            ("de", false),
            ("EN", false),
            ("ru_RU", false),
        ] {
            let r = Settings::resolve(Overrides {
                lang: Some(v.into()),
                ..Default::default()
            });
            assert_eq!(r.is_ok(), ok, "{v}");
        }
        let back: Overrides = toml::from_str("lang = \"en\"\n").unwrap();
        assert_eq!(back.lang.as_deref(), Some("en"));
    }

    #[test]
    fn rejects_bad_retention() {
        assert!(
            Settings::resolve(Overrides {
                retention_days: Some(6),
                ..Default::default()
            })
            .is_err()
        );
        assert!(
            Settings::resolve(Overrides {
                retention_days: Some(91),
                ..Default::default()
            })
            .is_err()
        );
        assert!(
            Settings::resolve(Overrides {
                retention_days: Some(7),
                ..Default::default()
            })
            .is_ok()
        );
    }

    #[test]
    fn flags_override_file() {
        let file = Overrides {
            port: Some(1),
            family_name: Some("A".into()),
            ..Default::default()
        };
        let flags = Overrides {
            port: Some(2),
            ..Default::default()
        };
        let s = Settings::resolve(flags.or(file)).unwrap();
        assert_eq!(s.listen.port(), 2);
        assert_eq!(s.family_name, "A");
    }

    #[test]
    fn push_subject_from_file_names_the_file_and_value() {
        let e = Settings::resolve(Overrides {
            push_subject: Some("me@example.com".into()),
            ..Default::default()
        })
        .unwrap_err();
        assert!(e.contains("config.toml") && e.contains("me@example.com"), "{e}");
    }

    #[test]
    fn offer_setup_round_trips_and_defaults_to_false() {
        let s = Settings::resolve(Overrides::default()).unwrap();
        assert!(!s.offer_setup);
        let on = Settings::resolve(Overrides {
            offer_setup: Some(true),
            ..Default::default()
        })
        .unwrap();
        let back: Overrides = toml::from_str(&config_template(&on)).unwrap();
        assert_eq!(back.offer_setup, Some(true));
    }

    const TOKEN: &str = "123456:AAsecretValueForUnitTests_0123456";

    #[test]
    fn telegram_token_is_secret_everywhere() {
        let o = Overrides {
            telegram_bot_token: Some(Secret::new(TOKEN)),
            ..Default::default()
        };
        assert!(!format!("{o:?}").contains("AAsecret"));
        let s = Settings::resolve(o).unwrap();
        assert!(!format!("{s:?}").contains("AAsecret"));
        assert_eq!(s.telegram.as_ref().unwrap().token.expose(), TOKEN);
        assert_eq!(s.telegram.as_ref().unwrap().api_url, DEFAULT_TELEGRAM_API_URL);
        // The template never holds the token, only a commented line.
        let t = config_template(&s);
        assert!(!t.contains(TOKEN) && t.contains("# telegram_bot_token = \"\""), "{t}");
        // Empty turns loading off.
        let off = Settings::resolve(Overrides {
            telegram_bot_token: Some(Secret::new("  ")),
            ..Default::default()
        })
        .unwrap();
        assert!(off.telegram.is_none());
    }

    #[test]
    fn telegram_errors_name_the_source_not_the_value() {
        let e = Settings::resolve(Overrides {
            telegram_bot_token: Some(Secret::new("not-a-token-secretvalue")),
            ..Default::default()
        })
        .unwrap_err();
        assert!(e.contains("telegram_bot_token") && !e.contains("secretvalue"), "{e}");
        // A TOML error on the token's line shows the line number, not the line.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("config.toml");
        std::fs::write(&p, format!("port = 1\ntelegram_bot_token = \"{TOKEN}\n")).unwrap();
        let e = read_config_file(&p).unwrap_err();
        assert!(!e.contains("AAsecret") && e.contains("2"), "{e}");
    }

    #[test]
    fn telegram_api_url_rules() {
        let url = |u: &str, allow: bool| {
            Settings::resolve(Overrides {
                telegram_bot_token: Some(Secret::new(TOKEN)),
                telegram_api_url: Some(u.into()),
                telegram_api_allow_http: Some(allow),
                ..Default::default()
            })
            .map(|s| s.telegram.unwrap().api_url)
        };
        assert_eq!(url("https://tg.example.org/", false).unwrap(), "https://tg.example.org");
        assert!(url("http://127.0.0.1:8081", false).is_ok());
        assert!(url("http://telegram-bot-api:8081", false).is_err());
        assert!(url("http://telegram-bot-api:8081", true).is_ok());
        assert!(url("ftp://x", true).is_err());
        assert!(url("https://user@x", false).is_err());
    }
}
