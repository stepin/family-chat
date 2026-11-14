//! The web client is embedded into the binary; it has to be built first.
//! Also records the git commit for `fcd --version` and `/v1/hello`.

use std::path::Path;
use std::process::Command;

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

    // The commit: FCD_GIT_COMMIT (release builds and Docker, where .git is
    // not available) or `git rev-parse`, otherwise empty.
    println!("cargo::rerun-if-env-changed=FCD_GIT_COMMIT");
    let commit = std::env::var("FCD_GIT_COMMIT")
        .ok()
        .or_else(|| git_commit(Path::new(&manifest_dir)))
        .map(|c| c.trim().chars().take(12).collect::<String>())
        .filter(|c| !c.is_empty() && c.chars().all(|ch| ch.is_ascii_hexdigit()))
        .unwrap_or_default();
    println!("cargo::rustc-env=FCD_GIT_COMMIT={commit}");
    let version = std::env::var("CARGO_PKG_VERSION").expect("set by cargo");
    let line = if commit.is_empty() {
        version
    } else {
        format!("{version} (commit {commit})")
    };
    println!("cargo::rustc-env=FCD_VERSION_LINE={line}");
}

fn git_commit(manifest_dir: &Path) -> Option<String> {
    let git_dir = manifest_dir.join("../.git");
    if !git_dir.is_dir() {
        return None;
    }
    // Rebuild when HEAD moves: HEAD itself, the branch it points to, packed
    // refs. Only existing files: a missing one would rerun this every build.
    let mut watch = vec!["HEAD".to_string(), "packed-refs".to_string()];
    if let Ok(head) = std::fs::read_to_string(git_dir.join("HEAD"))
        && let Some(r) = head.trim().strip_prefix("ref: ")
    {
        watch.push(r.to_string());
    }
    for f in watch {
        if git_dir.join(&f).is_file() {
            println!("cargo::rerun-if-changed=../.git/{f}");
        }
    }
    let out = Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .current_dir(manifest_dir)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}
