//! The web client is embedded into the binary; it has to be built first.

use std::path::Path;

fn main() {
    println!("cargo::rerun-if-changed=../apps/web/dist");
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("set by cargo");
    let dist = Path::new(&manifest_dir).join("../apps/web/dist");
    if !dist.join("index.html").is_file() {
        println!(
            "cargo::error=apps/web/dist/index.html not found: the web client is embedded into fcd, \
             build it first with `pnpm install && pnpm build` in the repository root"
        );
    }
}
