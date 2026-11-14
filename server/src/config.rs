//! Settings: command-line flags override `config.toml`, which overrides defaults.

use std::net::{IpAddr, SocketAddr};
use std::path::Path;

use serde::Deserialize;

pub const DEFAULT_PORT: u16 = 8787;
pub const DEFAULT_LISTEN: &str = "0.0.0.0";
pub const DEFAULT_FAMILY_NAME: &str = "Семья";
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
}

impl Settings {
    pub fn resolve(o: Overrides) -> Result<Settings, String> {
        let ip: IpAddr = o
            .listen
            .as_deref()
            .unwrap_or(DEFAULT_LISTEN)
            .parse()
            .map_err(|_| "адрес прослушивания (listen) должен быть IP-адресом, например 0.0.0.0".to_string())?;
        let retention_days = o.retention_days.unwrap_or(DEFAULT_RETENTION_DAYS);
        if !(7..=90).contains(&retention_days) {
            return Err(format!(
                "срок хранения (retention_days) должен быть от 7 до 90 дней, указано {retention_days}"
            ));
        }
        let max_file_mb = o.max_file_mb.unwrap_or(DEFAULT_MAX_FILE_MB);
        if max_file_mb == 0 {
            return Err("предел файла (max_file_mb) должен быть больше нуля".into());
        }
        let family_name = o
            .family_name
            .unwrap_or_else(|| DEFAULT_FAMILY_NAME.into())
            .trim()
            .to_string();
        if family_name.is_empty() || family_name.chars().count() > 100 {
            return Err("имя семьи (family_name) должно быть от 1 до 100 символов".into());
        }
        let push_subject = o.push_subject.unwrap_or_else(|| DEFAULT_PUSH_SUBJECT.into());
        if !(push_subject.starts_with("mailto:") || push_subject.starts_with("https://")) {
            return Err("push_subject должен начинаться с mailto: или https://".into());
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
        })
    }
}

pub fn read_config_file(path: &Path) -> Result<Overrides, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => toml::from_str(&text).map_err(|e| format!("ошибка в {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Overrides::default()),
        Err(e) => Err(format!("не удалось прочитать {}: {e}", path.display())),
    }
}

/// Text of `config.toml` written at first start, with the effective values.
pub fn config_template(s: &Settings) -> String {
    let family = toml::Value::String(s.family_name.clone()).to_string();
    format!(
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
"#,
        port = s.listen.port(),
        ip = s.listen.ip(),
        retention = s.retention_days,
        max_file = s.max_file_mb,
        push = s.push,
        min_free = s.min_free_mb,
        trust_xff = s.trust_forwarded_for,
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
}
