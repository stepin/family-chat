//! M7: the real binary in both languages and with settings from the
//! environment. Each test runs `fcd` as a child process with its own
//! environment, so nothing races on the test process's variables.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Output, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// `fcd` with a clean language environment plus `vars`.
fn fcd(args: &[&str], vars: &[(&str, &str)]) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_fcd"));
    for k in ["LANG", "LC_ALL", "LC_MESSAGES", "RUST_LOG"] {
        c.env_remove(k);
    }
    for (k, _) in std::env::vars().filter(|(k, _)| k.starts_with("FCD_")) {
        c.env_remove(k);
    }
    c.env("NO_COLOR", "1").args(args);
    for (k, v) in vars {
        c.env(k, v);
    }
    c
}

fn run(args: &[&str], vars: &[(&str, &str)]) -> Output {
    fcd(args, vars).output().unwrap()
}

fn text(o: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

fn has_cyrillic(s: &str) -> bool {
    s.chars().any(|c| ('\u{0400}'..='\u{04ff}').contains(&c))
}

/// A running server; lines of its output arrive on a channel.
struct Server {
    child: Child,
    lines: mpsc::Receiver<String>,
    seen: Vec<String>,
}

impl Server {
    fn start(args: &[&str], vars: &[(&str, &str)]) -> Server {
        let mut child = fcd(args, vars)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let (tx, lines) = mpsc::channel();
        for r in [
            Box::new(child.stdout.take().unwrap()) as Box<dyn std::io::Read + Send>,
            Box::new(child.stderr.take().unwrap()),
        ] {
            let tx = tx.clone();
            std::thread::spawn(move || {
                for l in BufReader::new(r).lines().map_while(Result::ok) {
                    let _ = tx.send(l);
                }
            });
        }
        Server {
            child,
            lines,
            seen: Vec::new(),
        }
    }

    fn wait_line(&mut self, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            match self
                .lines
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok(l) => {
                    self.seen.push(l.clone());
                    if l.contains(needle) {
                        return l;
                    }
                }
                Err(_) => panic!("no line with {needle:?}; output:\n{}", self.seen.join("\n")),
            }
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn port_of(line: &str) -> String {
    line.rsplit(':')
        .next()
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .to_string()
}

#[test]
fn help_in_both_languages_names_the_variables() {
    let ru = text(&run(&["--help"], &[]));
    assert!(ru.contains("Использование: fcd [ПАРАМЕТРЫ] [КОМАНДА]"), "{ru}");
    assert!(
        ru.contains("Папка данных") && ru.contains("переменная: FCD_DATA"),
        "{ru}"
    );
    let en = text(&run(&["--help"], &[("LANG", "en_US.UTF-8")]));
    assert!(
        en.contains("Usage: fcd [OPTIONS] [COMMAND]") && en.contains("env: FCD_PORT"),
        "{en}"
    );
    assert!(!has_cyrillic(&en), "{en}");
    // --lang and FCD_LANG win over the locale.
    assert!(text(&run(&["--help", "--lang", "ru"], &[("LANG", "en_US.UTF-8")])).contains("Использование"));
    assert!(text(&run(&["admin", "--help"], &[("FCD_LANG", "en")])).contains("Manage administrators"));
    // Subcommands too.
    let hc = text(&run(&["healthcheck", "--help"], &[]));
    assert!(hc.contains("Проверить, что сервер на этой машине отвечает"), "{hc}");
}

#[test]
fn errors_in_both_languages() {
    let ru = run(&["--bogus"], &[]);
    assert_eq!(ru.status.code(), Some(2));
    assert!(text(&ru).contains("неизвестный параметр «--bogus»"), "{}", text(&ru));
    let en = run(&["--bogus"], &[("LC_ALL", "en_GB.UTF-8")]);
    assert!(text(&en).contains("unexpected argument '--bogus'"), "{}", text(&en));
    let no_data = run(&[], &[("LANG", "en_US.UTF-8")]);
    assert!(
        text(&no_data).contains("error: give the data folder"),
        "{}",
        text(&no_data)
    );
    let ru_data = run(&[], &[]);
    assert!(
        text(&ru_data).contains("ошибка: укажите папку данных"),
        "{}",
        text(&ru_data)
    );
    // Invalid variables name the variable, in the chosen language.
    let bad = run(
        &["--data", "/nonexistent"],
        &[("FCD_PUSH", "maybe"), ("FCD_LANG", "en")],
    );
    assert_eq!(bad.status.code(), Some(2));
    assert!(
        text(&bad).contains("environment variable FCD_PUSH: invalid value “maybe”"),
        "{}",
        text(&bad)
    );
    let bad_ru = run(&["--data", "/nonexistent"], &[("FCD_PORT", "eighty")]);
    assert!(
        text(&bad_ru).contains("переменная окружения FCD_PORT: недопустимое значение «eighty»"),
        "{}",
        text(&bad_ru)
    );
}

#[test]
fn start_up_admin_and_reset_in_english() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().to_str().unwrap();
    let mut srv = Server::start(
        &[
            "--data",
            data,
            "--listen",
            "127.0.0.1",
            "--port",
            "0",
            "--push",
            "false",
            "--lang",
            "en",
        ],
        &[],
    );
    let listen = srv.wait_line("listening on 127.0.0.1:");
    srv.wait_line("first start: the data folder was created");
    let code = srv.wait_line("admin code: ");
    assert_eq!(code.rsplit(' ').next().unwrap().len(), 19, "{code}");
    srv.wait_line("next: open the app");
    assert!(srv.seen.iter().all(|l| !has_cyrillic(l)), "{}", srv.seen.join("\n"));
    let config = std::fs::read_to_string(tmp.path().join("config.toml")).unwrap();
    assert!(
        config.contains("# fcd settings.") && config.contains("family_name = \"Family\""),
        "{config}"
    );

    let hc = run(
        &[
            "healthcheck",
            "--listen",
            "127.0.0.1",
            "--port",
            &port_of(&listen),
            "--lang",
            "en",
        ],
        &[],
    );
    assert!(
        hc.status.success() && text(&hc).contains("is answering on"),
        "{}",
        text(&hc)
    );
    drop(srv);

    let list = run(&["admin", "list", "--data", data], &[("LANG", "en_US.UTF-8")]);
    assert!(text(&list).contains("no members yet"), "{}", text(&list));
    let list_ru = run(&["admin", "list", "--data", data], &[]);
    // config.toml says nothing about the language: Russian by default.
    assert!(text(&list_ru).contains("участников пока нет"), "{}", text(&list_ru));
    let reset = run(&["reset-admin-code", "--data", data], &[("FCD_LANG", "en")]);
    assert!(text(&reset).contains("New administrator code: "), "{}", text(&reset));
    let add = run(&["admin", "add", "nope", "--data", data, "--lang", "en"], &[]);
    assert!(text(&add).contains("does not look like a userId"), "{}", text(&add));

    // `lang` in config.toml is honoured.
    std::fs::write(tmp.path().join("config.toml"), format!("{config}\nlang = \"en\"\n")).unwrap();
    let from_config = run(&["admin", "list", "--data", data], &[]);
    assert!(text(&from_config).contains("no members yet"), "{}", text(&from_config));
}

#[test]
fn settings_from_the_environment() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().to_str().unwrap();
    // No flags at all: data folder, address, port, family and push from the environment.
    let vars = [
        ("FCD_DATA", data),
        ("FCD_LISTEN", "127.0.0.1"),
        ("FCD_PORT", "0"),
        ("FCD_PUSH", "0"),
        ("FCD_FAMILY_NAME", "Ивановы"),
        ("FCD_RETENTION_DAYS", "30"),
        ("FCD_LANG", ""),
        ("FCD_BIN", "/unrelated"),
    ];
    let mut srv = Server::start(&[], &vars);
    srv.wait_line("семья «Ивановы», срок хранения 30 дн.");
    let listen = srv.wait_line("слушаю 127.0.0.1:");
    srv.wait_line("код администратора: ");
    // Written at first start, like the flags are.
    let config = std::fs::read_to_string(tmp.path().join("config.toml")).unwrap();
    assert!(
        config.contains("retention_days = 30") && config.contains("push = false"),
        "{config}"
    );

    // healthcheck reads the same variables (the container HEALTHCHECK has no flags for the port).
    let port = port_of(&listen);
    let hc = run(&["healthcheck"], &[("FCD_LISTEN", "127.0.0.1"), ("FCD_PORT", &port)]);
    assert!(hc.status.success(), "{}", text(&hc));
    assert!(text(&hc).contains("отвечает"), "{}", text(&hc));
    // A flag wins over the variable.
    let wrong = run(
        &["healthcheck", "--port", "1"],
        &[("FCD_LISTEN", "127.0.0.1"), ("FCD_PORT", &port)],
    );
    assert_eq!(wrong.status.code(), Some(1), "{}", text(&wrong));
}

#[test]
fn removed_m0_flag_stops_with_a_hint() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().to_str().unwrap();
    let ru = run(&["--data", data, "--m0"], &[]);
    assert_eq!(ru.status.code(), Some(2));
    let first = text(&ru).lines().next().unwrap_or_default().to_string();
    assert!(
        first.contains("--m0 убран в M8") && first.contains("Проверка сервера"),
        "{first}"
    );
    let en = run(&["--data", data, "--m0", "--lang", "en"], &[]);
    assert_eq!(en.status.code(), Some(2));
    let t = text(&en);
    assert!(t.contains("--m0 was removed in M8") && !has_cyrillic(&t), "{t}");
    // Nothing was created: the server did not start.
    assert!(!tmp.path().join("config.toml").exists());
}

#[test]
fn fcd_m0_variable_gives_one_warning() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().to_str().unwrap();
    let mut srv = Server::start(
        &[
            "--data",
            data,
            "--listen",
            "127.0.0.1",
            "--port",
            "0",
            "--push",
            "false",
            "--lang",
            "en",
        ],
        &[
            ("FCD_M0", "1"),
            ("FCD_PUSH_SUBJECT", "mailto:me@example.com"),
            ("FCD_MIN_FREE_MB", "0"),
        ],
    );
    srv.wait_line("listening on 127.0.0.1:");
    srv.wait_line("admin code: ");
    let warnings = srv.seen.iter().filter(|l| l.contains("FCD_M0")).count();
    assert_eq!(warnings, 1, "{}", srv.seen.join("\n"));
}
