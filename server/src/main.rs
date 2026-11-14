use clap::Parser;

#[tokio::main]
async fn main() {
    fcd::init_tracing();
    let code = fcd::main_with(fcd::Cli::parse()).await;
    std::process::exit(code);
}
