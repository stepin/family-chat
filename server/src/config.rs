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
        }
    }
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
}

impl Settings {
    pub fn resolve(o: Overrides) -> Result<Settings, String> {
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
        Ok(text) => toml::from_str(&text).map_err(|e| tr!("ошибка в {}: {e}", "error in {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Overrides::default()),
        Err(e) => Err(tr!(
            "не удалось прочитать {}: {e}",
            "could not read {}: {e}",
            path.display()
        )),
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
}
