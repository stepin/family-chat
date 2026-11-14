//! The web client: embedded from `apps/web/dist` at build time, or served
//! from a folder on disk with `--web-dir` (development).

use std::borrow::Cow;
use std::path::PathBuf;

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../apps/web/dist/"]
struct WebDist;

#[derive(Debug, Clone)]
pub enum Assets {
    Embedded,
    Dir(PathBuf),
}

struct Found {
    bytes: Cow<'static, [u8]>,
    mime: String,
    etag: Option<String>,
}

/// Only plain relative paths: no `..`, `.`, empty segments or backslashes.
fn safe_path(p: &str) -> bool {
    !p.contains('\\') && p.split('/').all(|s| !s.is_empty() && s != "." && s != "..")
}

impl Assets {
    async fn get(&self, rel: &str) -> Option<Found> {
        if !safe_path(rel) {
            return None;
        }
        match self {
            Assets::Embedded => WebDist::get(rel).map(|f| Found {
                mime: f.metadata.mimetype().to_string(),
                etag: Some(format!("\"{}\"", crate::datadir::hex(&f.metadata.sha256_hash()[..16]))),
                bytes: f.data,
            }),
            Assets::Dir(root) => {
                let path = root.join(rel);
                let meta = tokio::fs::metadata(&path).await.ok()?;
                if !meta.is_file() {
                    return None;
                }
                let bytes = tokio::fs::read(&path).await.ok()?;
                Some(Found {
                    bytes: Cow::Owned(bytes),
                    mime: mime_guess::from_path(&path).first_or_octet_stream().to_string(),
                    etag: None,
                })
            }
        }
    }

    async fn exists(&self, rel: &str) -> bool {
        self.get(rel).await.is_some()
    }

    /// Serves `GET`/`HEAD` for a non-API path.
    pub async fn serve(&self, method: &Method, uri: &Uri, headers: &HeaderMap) -> Response {
        if method != Method::GET && method != Method::HEAD {
            return (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "GET, HEAD")]).into_response();
        }
        let path = uri.path().trim_start_matches('/');
        let rel = if path.is_empty() || path.ends_with('/') {
            format!("{path}index.html")
        } else {
            path.to_string()
        };

        let Some(found) = self.get(&rel).await else {
            // `/server` -> `/server/`, so relative links inside the page work.
            let last = path.rsplit('/').next().unwrap_or("");
            if !path.is_empty()
                && !path.ends_with('/')
                && !last.contains('.')
                && self.exists(&format!("{path}/index.html")).await
            {
                let mut loc = format!("/{path}/");
                if let Some(q) = uri.query() {
                    loc.push('?');
                    loc.push_str(q);
                }
                return (StatusCode::PERMANENT_REDIRECT, [(header::LOCATION, loc)]).into_response();
            }
            return (
                StatusCode::NOT_FOUND,
                [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
                "Not found\n",
            )
                .into_response();
        };

        let cache = if rel.starts_with("assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        if let (Some(etag), Some(inm)) = (&found.etag, headers.get(header::IF_NONE_MATCH))
            && inm.to_str().is_ok_and(|v| v.split(',').any(|t| t.trim() == etag))
        {
            return (
                StatusCode::NOT_MODIFIED,
                [(header::ETAG, etag.clone()), (header::CACHE_CONTROL, cache.into())],
            )
                .into_response();
        }

        let mut mime = found.mime;
        if (mime.starts_with("text/") || mime == "application/javascript" || mime == "application/manifest+json")
            && !mime.contains("charset")
        {
            mime.push_str("; charset=utf-8");
        }
        let mut res = Response::new(Body::from(found.bytes));
        let h = res.headers_mut();
        h.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("application/octet-stream")),
        );
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
        h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
        if let Some(v) = found.etag.and_then(|e| HeaderValue::from_str(&e).ok()) {
            h.insert(header::ETAG, v);
        }
        res
    }
}

#[cfg(test)]
mod tests {
    use super::safe_path;

    #[test]
    fn rejects_traversal() {
        assert!(safe_path("index.html"));
        assert!(safe_path("server/index.html"));
        assert!(!safe_path("../secret"));
        assert!(!safe_path("a/../../b"));
        assert!(!safe_path("a//b"));
        assert!(!safe_path("a\\b"));
        assert!(!safe_path("./a"));
    }
}
