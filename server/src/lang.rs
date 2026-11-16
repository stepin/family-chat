//! Language of everything a person reads from `fcd`: console output,
//! log messages for the administrator, `--help`, error messages. Russian or
//! English; Russian by default.
//!
//! Chosen once at start, before the command line is parsed (the help text
//! depends on it): `--lang ru|en`, else `FCD_LANG`, else `lang` in
//! `<DIR>/config.toml` (the folder from `--data` or `FCD_DATA`), else the
//! locale variables `LC_ALL`, `LC_MESSAGES`, `LANG` (the first one that
//! is set decides, as in POSIX), else Russian. API responses stay machine
//! codes; the client words them.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Lang {
    #[default]
    Ru,
    En,
}

static CURRENT: AtomicU8 = AtomicU8::new(0);

impl Lang {
    /// `ru`, `en`, and locale names such as `ru_RU.UTF-8` or `en-US`.
    pub fn parse(s: &str) -> Option<Lang> {
        let primary = s.trim().split(['_', '-', '.', '@']).next()?.to_ascii_lowercase();
        match primary.as_str() {
            "ru" => Some(Lang::Ru),
            "en" => Some(Lang::En),
            _ => None,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Lang::Ru => "ru",
            Lang::En => "en",
        }
    }
}

/// The language of this process.
pub fn current() -> Lang {
    if CURRENT.load(Ordering::Relaxed) == 1 {
        Lang::En
    } else {
        Lang::Ru
    }
}

pub fn set(lang: Lang) {
    CURRENT.store(if lang == Lang::En { 1 } else { 0 }, Ordering::Relaxed);
}

/// One of two fixed texts by the current language.
pub fn l(ru: &'static str, en: &'static str) -> &'static str {
    match current() {
        Lang::Ru => ru,
        Lang::En => en,
    }
}

/// Formats the Russian or the English text (`format!` arguments are shared).
#[macro_export]
macro_rules! tr {
    ($ru:literal, $en:literal $(,)?) => {
        match $crate::lang::current() {
            $crate::lang::Lang::Ru => format!($ru),
            $crate::lang::Lang::En => format!($en),
        }
    };
    ($ru:literal, $en:literal, $($arg:tt)+) => {
        match $crate::lang::current() {
            $crate::lang::Lang::Ru => format!($ru, $($arg)+),
            $crate::lang::Lang::En => format!($en, $($arg)+),
        }
    };
}

/// The language from the locale variables: the first of `LC_ALL`,
/// `LC_MESSAGES`, `LANG` that is set and not empty decides; `None` when it
/// names neither Russian nor English (or none is set).
pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Option<Lang> {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|k| get(k).filter(|v| !v.trim().is_empty()))
        .and_then(|v| Lang::parse(&v))
}

/// The rule: the flag, then the configuration file, then the environment, then Russian.
pub fn select(flag: Option<Lang>, config: Option<Lang>, env: Option<Lang>) -> Lang {
    flag.or(config).or(env).unwrap_or_default()
}

/// A variable that is set and not empty (containers often pass empty ones).
pub fn non_empty(get: &impl Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    get(name).filter(|v| !v.trim().is_empty())
}

/// What the command line says before it is parsed: the value of `--lang`
/// (valid or not) and of `--data`.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct EarlyArgs {
    pub lang: Option<String>,
    pub data: Option<PathBuf>,
}

pub fn scan_args<I: IntoIterator<Item = String>>(args: I) -> EarlyArgs {
    let mut out = EarlyArgs::default();
    let mut it = args.into_iter().skip(1);
    while let Some(a) = it.next() {
        if a == "--" {
            break;
        }
        if let Some(v) = a.strip_prefix("--lang=") {
            out.lang = Some(v.to_string());
        } else if a == "--lang" {
            out.lang = it.next();
        } else if let Some(v) = a.strip_prefix("--data=") {
            out.data = Some(PathBuf::from(v));
        } else if a == "--data" {
            out.data = it.next().map(PathBuf::from);
        }
    }
    out
}

/// `lang` from `<DIR>/config.toml`, read leniently (a broken file is reported later, by the normal start).
pub fn from_config(data: &Path) -> Option<Lang> {
    let text = std::fs::read_to_string(data.join(crate::datadir::CONFIG_FILE)).ok()?;
    let v: toml::Table = toml::from_str(&text).ok()?;
    v.get("lang")?.as_str().and_then(Lang::parse)
}

/// Chooses the language for this process from the arguments, the data
/// folder's configuration and the environment, and makes it current.
pub fn init_from<I: IntoIterator<Item = String>>(args: I, get_env: impl Fn(&str) -> Option<String>) -> Lang {
    let early = scan_args(args);
    // The flag, then FCD_LANG (an environment variable counts like the flag).
    let flag = early
        .lang
        .or_else(|| non_empty(&get_env, "FCD_LANG"))
        .as_deref()
        .and_then(Lang::parse);
    let data = early
        .data
        .or_else(|| non_empty(&get_env, "FCD_DATA").map(PathBuf::from));
    let config = data.as_deref().and_then(from_config);
    let lang = select(flag, config, from_env(get_env));
    set(lang);
    lang
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        std::iter::once("fcd")
            .chain(a.iter().copied())
            .map(String::from)
            .collect()
    }

    #[test]
    fn parses_codes_and_locale_names() {
        assert_eq!(Lang::parse("ru"), Some(Lang::Ru));
        assert_eq!(Lang::parse("EN"), Some(Lang::En));
        assert_eq!(Lang::parse("ru_RU.UTF-8"), Some(Lang::Ru));
        assert_eq!(Lang::parse("en_GB.utf8@euro"), Some(Lang::En));
        assert_eq!(Lang::parse("en-US"), Some(Lang::En));
        assert_eq!(Lang::parse("de_DE.UTF-8"), None);
        assert_eq!(Lang::parse("C.UTF-8"), None);
        assert_eq!(Lang::parse(""), None);
    }

    #[test]
    fn environment_order_is_posix() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
        };
        assert_eq!(from_env(env(&[("LANG", "en_US.UTF-8")])), Some(Lang::En));
        assert_eq!(
            from_env(env(&[("LANG", "en_US.UTF-8"), ("LC_MESSAGES", "ru_RU.UTF-8")])),
            Some(Lang::Ru)
        );
        assert_eq!(
            from_env(env(&[("LC_ALL", "en_US.UTF-8"), ("LC_MESSAGES", "ru_RU.UTF-8")])),
            Some(Lang::En)
        );
        // An empty variable does not count; the first set one decides even if it is neither language.
        assert_eq!(from_env(env(&[("LC_ALL", ""), ("LANG", "en_US")])), Some(Lang::En));
        assert_eq!(from_env(env(&[("LC_ALL", "C"), ("LANG", "en_US")])), None);
        assert_eq!(from_env(env(&[])), None);
    }

    #[test]
    fn flag_then_config_then_environment_then_russian() {
        assert_eq!(select(Some(Lang::En), Some(Lang::Ru), Some(Lang::Ru)), Lang::En);
        assert_eq!(select(None, Some(Lang::En), Some(Lang::Ru)), Lang::En);
        assert_eq!(select(None, None, Some(Lang::En)), Lang::En);
        assert_eq!(select(None, None, None), Lang::Ru);
    }

    #[test]
    fn scans_the_command_line_before_parsing() {
        assert_eq!(
            scan_args(args(&["--lang", "en", "--data", "/srv/fc"])),
            EarlyArgs {
                lang: Some("en".into()),
                data: Some("/srv/fc".into())
            }
        );
        assert_eq!(
            scan_args(args(&["admin", "list", "--data=/d", "--lang=ru"])),
            EarlyArgs {
                lang: Some("ru".into()),
                data: Some("/d".into())
            }
        );
        assert_eq!(scan_args(args(&["--", "--lang", "en"])), EarlyArgs::default());
        assert_eq!(scan_args(args(&["--port", "1"])), EarlyArgs::default());
    }

    #[test]
    fn fcd_lang_and_fcd_data_count_like_the_flags() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.toml"), "lang = \"en\"\n").unwrap();
        let d = dir.path().to_str().unwrap().to_string();
        let early = |a: &[&str], env: Vec<(&'static str, String)>| {
            let a = args(a);
            let get = move |k: &str| env.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone());
            let e = scan_args(a);
            let flag = e
                .lang
                .or_else(|| non_empty(&get, "FCD_LANG"))
                .as_deref()
                .and_then(Lang::parse);
            let data = e.data.or_else(|| non_empty(&get, "FCD_DATA").map(PathBuf::from));
            select(flag, data.as_deref().and_then(from_config), from_env(&get))
        };
        // FCD_DATA points at the config, which says en.
        assert_eq!(early(&[], vec![("FCD_DATA", d.clone())]), Lang::En);
        // FCD_LANG wins over the config, the flag over FCD_LANG.
        assert_eq!(
            early(&[], vec![("FCD_DATA", d.clone()), ("FCD_LANG", "ru".into())]),
            Lang::Ru
        );
        assert_eq!(early(&["--lang", "en"], vec![("FCD_LANG", "ru".into())]), Lang::En);
        // An empty FCD_LANG counts as not set.
        assert_eq!(
            early(&[], vec![("FCD_LANG", "".into()), ("LANG", "en_US.UTF-8".into())]),
            Lang::En
        );
    }

    #[test]
    fn reads_lang_from_the_config_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(from_config(dir.path()), None);
        std::fs::write(dir.path().join("config.toml"), "port = 1\nlang = \"en\"\n").unwrap();
        assert_eq!(from_config(dir.path()), Some(Lang::En));
        std::fs::write(dir.path().join("config.toml"), "lang = \"de\"\n").unwrap();
        assert_eq!(from_config(dir.path()), None);
        std::fs::write(dir.path().join("config.toml"), "not toml [").unwrap();
        assert_eq!(from_config(dir.path()), None);
    }
}
