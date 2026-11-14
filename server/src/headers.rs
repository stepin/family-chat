//! Security headers on every response: the embedded client gets its
//! Content-Security-Policy as a header (the same policy as the `<meta>` tag
//! from `apps/web/vite.config.ts`, plus `frame-ancestors`, which a `<meta>`
//! tag cannot carry); API responses are never cached and never rendered as
//! documents.

use axum::extract::Request;
use axum::http::{HeaderValue, header};
use axum::middleware::Next;
use axum::response::Response;

/// `CSP` from `apps/web/vite.config.ts` (a test checks they match).
pub const CLIENT_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; \
                              font-src 'self'; connect-src 'self' https:; worker-src 'self'; manifest-src 'self'; \
                              base-uri 'none'; form-action 'none'";

/// Header value for the static client.
pub fn client_csp_header() -> String {
    format!("{CLIENT_CSP}; frame-ancestors 'none'")
}

/// API responses (JSON, event bodies, attachments, avatars) must not be
/// rendered as a page with any rights.
pub const API_CSP: &str = "default-src 'none'; frame-ancestors 'none'; sandbox";

pub fn is_api_path(path: &str) -> bool {
    path.starts_with("/v1/") || path == "/v1"
}

pub async fn security_headers(req: Request, next: Next) -> Response {
    let api = is_api_path(req.uri().path());
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    if api {
        h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(API_CSP));
        if !h.contains_key(header::CACHE_CONTROL) {
            h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        }
    } else if let Ok(v) = HeaderValue::from_str(&client_csp_header()) {
        h.insert(header::CONTENT_SECURITY_POLICY, v);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The policy must stay equal to the one the web build puts into its
    /// `<meta>` tag, or the header and the tag would disagree.
    #[test]
    fn matches_vite_config() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../apps/web/vite.config.ts"))
            .expect("apps/web/vite.config.ts");
        let start = src.find("export const CSP = [").expect("CSP array") + "export const CSP = [".len();
        let end = start + src[start..].find("].join('; ')").expect("join");
        let parts: Vec<String> = src[start..end]
            .split(',')
            .map(|p| p.trim().trim_matches('"').to_string())
            .filter(|p| !p.is_empty())
            .collect();
        assert_eq!(parts.join("; "), CLIENT_CSP);
    }
}
