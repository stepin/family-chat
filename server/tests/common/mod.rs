#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use fcd::app::{self, AppState};
use fcd::assets::Assets;
use fcd::config::Overrides;
use fcd::datadir::DataDir;
use fcd::webpush::PushClient;
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use tokio::sync::watch;

pub struct TestServer {
    pub addr: SocketAddr,
    pub admin_code: String,
    pub dir: DataDir,
    pub shutdown: watch::Sender<bool>,
}

impl TestServer {
    pub fn url(&self, path: &str) -> String {
        format!("http://{}{}", self.addr, path)
    }
}

/// Starts the router in-process on 127.0.0.1 with a fresh data folder.
pub async fn start(data: &Path, m0: bool, flags: Overrides) -> TestServer {
    let (dir, settings) = DataDir::open(data, flags).expect("open data dir");
    let admin_code = dir.new_admin_code.clone().expect("first start");
    let (tx, rx) = watch::channel(false);
    let state = Arc::new(AppState {
        push: settings.push.then(|| PushClient::new(settings.push_subject.clone())),
        settings,
        server_id: dir.server.server_id.clone(),
        admin_code_hash: dir.server.admin_code_hash.clone(),
        vapid: dir.vapid.clone(),
        m0,
        assets: Assets::Embedded,
        shutdown: rx,
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app::router(state)).await.unwrap();
    });
    TestServer {
        addr,
        admin_code,
        dir,
        shutdown: tx,
    }
}

pub struct Res {
    pub status: u16,
    pub headers: hyper::HeaderMap,
    pub body: Vec<u8>,
}

impl Res {
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).expect("json body")
    }
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }
}

pub async fn request(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&str>) -> Res {
    let client: Client<HttpConnector, Full<Bytes>> = Client::builder(TokioExecutor::new()).build_http();
    let mut b = hyper::Request::builder().method(method).uri(url);
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    let req = b.body(Full::new(Bytes::from(body.unwrap_or("").to_string()))).unwrap();
    let res = client.request(req).await.expect("request");
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    Res { status, headers, body }
}

pub async fn get(url: &str) -> Res {
    request("GET", url, &[], None).await
}
