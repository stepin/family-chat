#[tokio::main]
async fn main() {
    // The language decides the help text, so it is chosen before parsing (M7).
    fcd::lang::init_from(std::env::args_os().map(|a| a.to_string_lossy().into_owned()), |k| {
        std::env::var(k).ok()
    });
    let mut cli = match fcd::parse_cli(std::env::args_os()) {
        Ok(cli) => cli,
        Err(e) => std::process::exit(fcd::report_cli_error(&e)),
    };
    // Environment variables fill what the command line did not give (M7).
    if let Err(e) = cli.apply_env(|k| std::env::var(k).ok()) {
        eprintln!("{}: {e}", fcd::lang::l("ошибка", "error"));
        std::process::exit(2);
    }
    fcd::init_tracing();
    let code = fcd::main_with(cli).await;
    std::process::exit(code);
}
