//! Attachments over HTTP: resumable upload, limits, access, retention.

mod common;

use std::time::Duration;

use common::*;
use fcd::config::Overrides;
use fcd::ids::{BlobId, day_name, day_of_ms};
use serde_json::json;

fn new_blob() -> BlobId {
    BlobId(fcd::webpush::random_bytes::<16>())
}

fn bytes(n: usize, seed: u8) -> Vec<u8> {
    (0..n).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
}

#[tokio::test]
async fn upload_resume_download_delete() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), false, Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    let b = new_blob();
    let max_part = fcd::blobs::MAX_PART_BYTES as usize;

    let p0 = bytes(max_part, 1);
    let res = mama
        .send_bytes(&srv, "PUT", &format!("/v1/blobs/{b}/0"), p0.clone())
        .await;
    assert_eq!(res.status, 200, "{}", String::from_utf8_lossy(&res.body));
    assert_eq!(res.json()["size"], max_part);
    assert_eq!(res.json()["total"], max_part);
    let day = day_name(day_of_ms(fcd::datadir::now_ms()));
    let dir = tmp.path().join("blobs").join(&day).join(b.to_string());
    assert_eq!(std::fs::read(dir.join("0000")).unwrap(), p0);
    assert!(dir.join("meta.json").is_file());

    // The upload broke off during part 1: the client asks what is there and
    // sends part 1 again; the second copy replaces the first.
    let p1_bad = bytes(1000, 2);
    assert_eq!(
        mama.send_bytes(&srv, "PUT", &format!("/v1/blobs/{b}/1"), p1_bad)
            .await
            .status,
        200
    );
    let info = papa.get(&srv, &format!("/v1/blobs/{b}")).await.json();
    assert_eq!(info["owner"], mama.user.to_string());
    assert_eq!(
        info["parts"],
        json!([{"part": 0, "size": max_part}, {"part": 1, "size": 1000}])
    );
    let p1 = bytes(12345, 3);
    let res = mama
        .send_bytes(&srv, "PUT", &format!("/v1/blobs/{b}/1"), p1.clone())
        .await;
    assert_eq!(res.json()["total"], max_part + 12345);
    let info = papa.get(&srv, &format!("/v1/blobs/{b}")).await.json();
    assert_eq!(info["parts"][1]["size"], 12345);
    assert_eq!(info["total"], max_part + 12345);

    // Any member downloads; the answer is never a document.
    let res = papa.get(&srv, &format!("/v1/blobs/{b}/0")).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.body, p0);
    assert_eq!(res.header("content-type"), Some("application/octet-stream"));
    assert_eq!(res.header("content-length"), Some(max_part.to_string().as_str()));
    assert_eq!(res.header("content-disposition"), Some("attachment"));
    assert_eq!(res.header("x-content-type-options"), Some("nosniff"));
    assert!(res.header("content-security-policy").unwrap().contains("sandbox"));
    assert_eq!(papa.get(&srv, &format!("/v1/blobs/{b}/1")).await.body, p1);
    assert_eq!(papa.get(&srv, &format!("/v1/blobs/{b}/2")).await.status, 404);
    assert_eq!(get(&srv.url(&format!("/v1/blobs/{b}/0"))).await.status, 401);

    // Only the uploader adds parts or deletes.
    let res = papa.send_bytes(&srv, "PUT", &format!("/v1/blobs/{b}/2"), vec![1]).await;
    assert_eq!((res.status, res.json()["error"].clone()), (403, json!("not_owner")));
    let res = papa.send(&srv, "DELETE", &format!("/v1/blobs/{b}"), None).await;
    assert_eq!(res.status, 403);

    // Limits and formats.
    let res = mama
        .send_bytes(&srv, "PUT", &format!("/v1/blobs/{b}/2"), bytes(max_part + 1, 4))
        .await;
    assert_eq!(res.status, 413);
    assert_eq!(res.json()["limit"], max_part);
    assert_eq!(
        mama.send_bytes(&srv, "PUT", &format!("/v1/blobs/{b}/2"), vec![])
            .await
            .status,
        400
    );
    for bad in ["10000", "01", "-1", "x"] {
        assert_eq!(
            mama.send_bytes(&srv, "PUT", &format!("/v1/blobs/{b}/{bad}"), vec![1])
                .await
                .status,
            400,
            "{bad}"
        );
    }
    assert_eq!(
        mama.send_bytes(&srv, "PUT", "/v1/blobs/NOPE/0", vec![1]).await.status,
        400
    );
    assert_eq!(mama.get(&srv, &format!("/v1/blobs/{}", new_blob())).await.status, 404);
    // Nothing was left behind in tmp/.
    assert_eq!(std::fs::read_dir(tmp.path().join("tmp")).unwrap().count(), 0);

    // Kept across a restart.
    let data = tmp.path().to_path_buf();
    srv.stop().await;
    let srv = open(&data, false, Overrides::default()).await;
    assert_eq!(papa.get(&srv, &format!("/v1/blobs/{b}/1")).await.body, p1);
    let info = papa.get(&srv, &format!("/v1/blobs/{b}")).await.json();
    assert_eq!(info["total"], max_part + 12345);

    assert_eq!(
        mama.send(&srv, "DELETE", &format!("/v1/blobs/{b}"), None).await.status,
        204
    );
    assert!(!dir.exists());
    assert_eq!(papa.get(&srv, &format!("/v1/blobs/{b}/0")).await.status, 404);
    assert_eq!(
        mama.send(&srv, "DELETE", &format!("/v1/blobs/{b}"), None).await.status,
        404
    );
}

#[tokio::test]
async fn total_size_limit_and_free_space() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(
        tmp.path(),
        false,
        Overrides {
            max_file_mb: Some(1),
            ..Default::default()
        },
    )
    .await;
    let (mama, _papa) = family(&srv).await;
    let b = new_blob();
    let limit = 1024 * 1024 + fcd::blobs::TOTAL_SLACK_BYTES as usize;
    assert_eq!(
        mama.send_bytes(&srv, "PUT", &format!("/v1/blobs/{b}/0"), bytes(1024 * 1024, 1))
            .await
            .status,
        200
    );
    let res = mama
        .send_bytes(
            &srv,
            "PUT",
            &format!("/v1/blobs/{b}/1"),
            bytes(fcd::blobs::TOTAL_SLACK_BYTES as usize + 1, 2),
        )
        .await;
    assert_eq!(res.status, 413);
    assert_eq!(res.json()["limit"], limit);
    assert_eq!(
        mama.send_bytes(
            &srv,
            "PUT",
            &format!("/v1/blobs/{b}/1"),
            bytes(fcd::blobs::TOTAL_SLACK_BYTES as usize, 2)
        )
        .await
        .status,
        200
    );
    // Re-sending a part counts its new size only.
    assert_eq!(
        mama.send_bytes(&srv, "PUT", &format!("/v1/blobs/{b}/1"), bytes(10, 3))
            .await
            .status,
        200
    );
    assert_eq!(
        mama.get(&srv, &format!("/v1/blobs/{b}")).await.json()["maxBytes"],
        limit
    );
    let data = tmp.path().to_path_buf();
    srv.stop().await;

    let srv = open(
        &data,
        false,
        Overrides {
            min_free_mb: Some(u64::MAX / (1024 * 1024 * 2)),
            ..Default::default()
        },
    )
    .await;
    let res = mama
        .send_bytes(&srv, "PUT", &format!("/v1/blobs/{}/0", new_blob()), vec![1, 2, 3])
        .await;
    assert_eq!(
        (res.status, res.json()["error"].clone()),
        (507, serde_json::json!("storage_full"))
    );
}

#[tokio::test]
async fn retention_removes_old_attachment_days() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(
        tmp.path(),
        false,
        Overrides {
            retention_days: Some(7),
            ..Default::default()
        },
    )
    .await;
    let (mama, papa) = family(&srv).await;
    let old = new_blob();
    let fresh = new_blob();
    for b in [old, fresh] {
        assert_eq!(
            mama.send_bytes(&srv, "PUT", &format!("/v1/blobs/{b}/0"), vec![7; 100])
                .await
                .status,
            200
        );
    }
    let data = tmp.path().to_path_buf();
    srv.stop().await;
    // Move one attachment into a day folder older than the retention.
    let today = day_of_ms(fcd::datadir::now_ms());
    let old_day = data.join("blobs").join(day_name(today - 30));
    std::fs::create_dir_all(&old_day).unwrap();
    std::fs::rename(
        data.join("blobs").join(day_name(today)).join(old.to_string()),
        old_day.join(old.to_string()),
    )
    .unwrap();
    let srv = open(
        &data,
        false,
        Overrides {
            retention_days: Some(7),
            ..Default::default()
        },
    )
    .await;
    // The cleanup runs at start.
    let t = std::time::Instant::now();
    while old_day.exists() {
        assert!(t.elapsed() < Duration::from_secs(5), "old day folder not removed");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(papa.get(&srv, &format!("/v1/blobs/{old}/0")).await.status, 404);
    assert_eq!(papa.get(&srv, &format!("/v1/blobs/{old}")).await.status, 404);
    assert_eq!(papa.get(&srv, &format!("/v1/blobs/{fresh}/0")).await.body, vec![7; 100]);
}

/// Without `Content-Length` (chunked upload) the limit is enforced while
/// streaming, and the partial file is removed.
#[tokio::test]
async fn chunked_upload_over_the_limit_is_cut_off() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), false, Overrides::default()).await;
    let (mama, _papa) = family(&srv).await;
    let b = new_blob();
    let send = |total: usize| {
        let addr = srv.addr;
        let auth = mama.auth();
        async move {
            let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
            let head = format!(
                "PUT /v1/blobs/{b}/0 HTTP/1.1\r\nHost: x\r\nAuthorization: {auth}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
            );
            s.write_all(head.as_bytes()).await.unwrap();
            let chunk = vec![5u8; 64 * 1024];
            let mut sent = 0;
            while sent < total {
                let n = chunk.len().min(total - sent);
                if s.write_all(format!("{n:x}\r\n").as_bytes()).await.is_err()
                    || s.write_all(&chunk[..n]).await.is_err()
                    || s.write_all(b"\r\n").await.is_err()
                {
                    break;
                }
                sent += n;
            }
            let _ = s.write_all(b"0\r\n\r\n").await;
            let mut out = Vec::new();
            let _ = s.read_to_end(&mut out).await;
            String::from_utf8_lossy(&out).into_owned()
        }
    };
    let res = send(fcd::blobs::MAX_PART_BYTES as usize + 1).await;
    assert!(res.starts_with("HTTP/1.1 413"), "{res}");
    assert_eq!(std::fs::read_dir(tmp.path().join("tmp")).unwrap().count(), 0);
    assert_eq!(mama.get(&srv, &format!("/v1/blobs/{b}")).await.status, 404);
    let res = send(100_000).await;
    assert!(res.starts_with("HTTP/1.1 200"), "{res}");
    assert_eq!(mama.get(&srv, &format!("/v1/blobs/{b}/0")).await.body.len(), 100_000);
}
