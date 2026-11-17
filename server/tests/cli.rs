//! The real binary in both languages and with settings from the
//! environment. Each test runs `fcd` as a child process with its own
//! environment, so nothing races on the test process's variables.

mod common;

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
    let code = srv.wait_line("server admin code: ");
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
    assert!(text(&reset).contains("New server admin code: "), "{}", text(&reset));
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
    srv.wait_line("код администратора сервера: ");
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
fn telegram_token_never_reaches_the_log_or_the_config() {
    const TOKEN: &str = "987654:AAsecretTokenValueForTheLogTest_xyz";
    // A Bot API that always fails: getMe at start goes wrong, logged at debug level.
    let fake = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let api = format!("http://{}", fake.local_addr().unwrap());
    std::thread::spawn(move || {
        use std::io::{Read, Write};
        for mut s in fake.incoming().flatten() {
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf);
            let body = r#"{"ok":false,"error_code":500,"description":"Internal Server Error"}"#;
            let _ = write!(
                s,
                "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
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
        ],
        &[
            ("FCD_TELEGRAM_BOT_TOKEN", TOKEN),
            ("FCD_TELEGRAM_API_URL", &api),
            ("RUST_LOG", "debug"),
        ],
    );
    srv.wait_line("Загрузка стикеров из Telegram: Telegram недоступен");
    while let Ok(l) = srv.lines.recv_timeout(Duration::from_millis(300)) {
        srv.seen.push(l);
    }
    let all = srv.seen.join("\n");
    drop(srv);
    assert!(!all.contains(TOKEN) && !all.contains("AAsecret"), "{all}");
    assert!(all.contains("bot***/getMe"), "{all}");
    let config = std::fs::read_to_string(tmp.path().join("config.toml")).unwrap();
    assert!(!config.contains(TOKEN), "{config}");
    assert!(config.contains("# telegram_bot_token = \"\""), "{config}");

    // A token file works the same and is not copied into config.toml either.
    let file = tmp.path().join("token.txt");
    std::fs::write(&file, format!("{TOKEN}\n")).unwrap();
    let tmp2 = tempfile::tempdir().unwrap();
    let mut srv = Server::start(
        &[
            "--data",
            tmp2.path().to_str().unwrap(),
            "--listen",
            "127.0.0.1",
            "--port",
            "0",
            "--push",
            "false",
        ],
        &[
            ("FCD_TELEGRAM_BOT_TOKEN_FILE", file.to_str().unwrap()),
            ("FCD_TELEGRAM_API_URL", &api),
        ],
    );
    srv.wait_line("Загрузка стикеров из Telegram: Telegram недоступен");
    assert!(srv.seen.iter().all(|l| !l.contains(TOKEN)));
    drop(srv);
    let config = std::fs::read_to_string(tmp2.path().join("config.toml")).unwrap();
    assert!(!config.contains(TOKEN), "{config}");

    // A malformed token, or a broken config.toml line holding it: the error names the source, not the value.
    let bad = run(
        &["--data", tmp2.path().to_str().unwrap()],
        &[("FCD_TELEGRAM_BOT_TOKEN", "not a token secret-value")],
    );
    assert_eq!(bad.status.code(), Some(1), "{}", text(&bad));
    assert!(text(&bad).contains("FCD_TELEGRAM_BOT_TOKEN"), "{}", text(&bad));
    assert!(!text(&bad).contains("secret-value"), "{}", text(&bad));
    let config_path = tmp2.path().join("config.toml");
    std::fs::write(&config_path, format!("{config}\ntelegram_bot_token = \"{TOKEN}\n")).unwrap();
    let broken = run(&["--data", tmp2.path().to_str().unwrap()], &[]);
    assert_eq!(broken.status.code(), Some(1), "{}", text(&broken));
    assert!(text(&broken).contains("config.toml"), "{}", text(&broken));
    assert!(!text(&broken).contains(TOKEN), "{}", text(&broken));
}

/// A first start on a fresh folder; returns the server and its admin code and port.
fn fresh(data: &str) -> (Server, String, String) {
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
        ],
        &[],
    );
    let listen = srv.wait_line("слушаю 127.0.0.1:");
    let code = srv.wait_line("код администратора сервера: ");
    let code = code.rsplit(' ').next().unwrap().to_string();
    (srv, code, port_of(&listen))
}

/// A tiny HTTP/1.1 POST of JSON to 127.0.0.1 (no client crate in tests of the binary).
fn post_json(port: &str, path: &str, body: &str) -> (u16, String) {
    use std::io::{Read, Write};
    let mut s = std::net::TcpStream::connect(format!("127.0.0.1:{port}")).unwrap();
    write!(
        s,
        "POST {path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    let status = out.split(' ').nth(1).unwrap().parse().unwrap();
    (status, out.split("\r\n\r\n").nth(1).unwrap_or("").to_string())
}

#[test]
fn families_list_unknown_ids_healthcheck_and_a_clean_stop_after_creating_one() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().to_str().unwrap();
    let (mut srv, code, port) = fresh(data);
    // Root setup code first (fresh server), then a family.
    let (s, body) = post_json(&port, "/v1/families", &format!(r#"{{"adminCode":"{code}"}}"#));
    assert_eq!(s, 201);
    let setup = body.split("\"setupCode\":\"").nth(1).unwrap()[..19].to_string();
    let join = common::join_body(&common::new_key(), "Мама", "adminCode", &setup, &common::new_dev());
    assert_eq!(post_json(&port, "/v1/join", &join).0, 200);
    let (s, body) = post_json(
        &port,
        "/v1/families",
        &format!(r#"{{"adminCode":"{code}","familyName":"Петровы"}}"#),
    );
    assert_eq!(s, 201, "{body}");
    let id = body.split("\"familyId\":\"").nth(1).unwrap_or_else(|| panic!("{body}"))[..16].to_string();

    // Read only while the server runs.
    let list = run(&["families", "list", "--data", data], &[]);
    assert!(list.status.success(), "{}", text(&list));
    assert!(text(&list).contains("root  Семья  [настроена]"), "{}", text(&list));
    assert!(
        text(&list).contains(&format!("{id}  Петровы  [не настроена]")),
        "{}",
        text(&list)
    );

    // SIGTERM right after a runtime creation: a clean exit, the family on disk.
    #[cfg(unix)]
    {
        unsafe { libc_kill(srv.child.id() as i32) };
        let deadline = Instant::now() + Duration::from_secs(15);
        let status = loop {
            if let Some(st) = srv.child.try_wait().unwrap() {
                break st;
            }
            assert!(Instant::now() < deadline, "did not stop");
            std::thread::sleep(Duration::from_millis(50));
        };
        assert!(status.success(), "{status:?}");
    }
    drop(srv);
    assert!(tmp.path().join("families").join(&id).join("server.json").is_file());

    // --family with an unknown id: exit 1, the id, the folder and where to look.
    let bad = run(&["admin", "list", "--data", data, "--family", "zzzzzzzzzzzzzzzz"], &[]);
    assert_eq!(bad.status.code(), Some(1), "{}", text(&bad));
    assert!(
        text(&bad).contains("zzzzzzzzzzzzzzzz") && text(&bad).contains("fcd families list"),
        "{}",
        text(&bad)
    );
    let rec = run(&["reset-admin-code", "--data", data, "--family", &id], &[]);
    assert!(rec.status.success(), "{}", text(&rec));
    assert!(
        text(&rec).contains(&format!("Код восстановления семьи {id}: ")),
        "{}",
        text(&rec)
    );
    let list = run(&["admin", "list", "--data", data, "--family", &id], &[]);
    assert!(text(&list).contains("участников пока нет"), "{}", text(&list));

    // A broken family: healthcheck still 0 with a warning, 1 with --strict.
    std::fs::remove_file(tmp.path().join("families").join(&id).join("server.json")).unwrap();
    let (srv, _, _) = {
        let mut s = Server::start(
            &[
                "--data",
                data,
                "--listen",
                "127.0.0.1",
                "--port",
                "0",
                "--push",
                "false",
            ],
            &[],
        );
        s.wait_line(&format!("семья {id} сломана"));
        let listen = s.wait_line("слушаю 127.0.0.1:");
        let p = port_of(&listen);
        (s, String::new(), p)
    };
    let port = port_of(srv.seen.iter().find(|l| l.contains("слушаю")).unwrap());
    let hc = run(
        &["healthcheck", "--data", data, "--listen", "127.0.0.1", "--port", &port],
        &[],
    );
    assert_eq!(hc.status.code(), Some(0), "{}", text(&hc));
    assert!(text(&hc).contains(&format!("семья {id} сломана")), "{}", text(&hc));
    let strict = run(
        &[
            "healthcheck",
            "--strict",
            "--data",
            data,
            "--listen",
            "127.0.0.1",
            "--port",
            &port,
        ],
        &[],
    );
    assert_eq!(strict.status.code(), Some(1), "{}", text(&strict));
    drop(srv);
    let list = run(&["families", "list", "--data", data], &[]);
    assert!(
        text(&list).contains(&format!("{id}  (без имени)  [сломана")),
        "{}",
        text(&list)
    );
}

#[cfg(unix)]
unsafe fn libc_kill(pid: i32) {
    unsafe extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe { kill(pid, 15) };
}

#[test]
fn offer_setup_line_stops_the_server_and_says_to_remove_it() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().to_str().unwrap();
    std::fs::write(tmp.path().join("config.toml"), "port = 0\noffer_setup = true\n").unwrap();
    for args in [vec!["--data", data], vec!["reset-admin-code", "--data", data]] {
        let o = run(&args, &[]);
        assert_eq!(o.status.code(), Some(1), "{}", text(&o));
        assert!(
            text(&o).contains("offer_setup") && text(&o).contains("удалите"),
            "{}",
            text(&o)
        );
    }
    // The flag is gone too.
    let o = run(&["--data", data, "--offer-setup", "true"], &[]);
    assert_eq!(o.status.code(), Some(2), "{}", text(&o));
}
