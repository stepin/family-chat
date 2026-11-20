//! Over HTTP: MCP connections managed from the app (`/v1/mcp`).

mod common;

use common::person::Person;
use common::*;
use fcd::config::Overrides;
use serde_json::{Value, json};

fn text(r: &Res) -> String {
    String::from_utf8_lossy(&r.body).into_owned()
}

fn helper_body(name: &str) -> String {
    json!({ "mode": "helper", "name": name }).to_string()
}

fn me_body(name: &str, seed: &[u8; 32]) -> String {
    json!({ "mode": "me", "name": name, "seed": b64e(seed) }).to_string()
}

fn connections(res: &Res) -> Vec<Value> {
    assert_eq!(res.status, 200, "{}", text(res));
    res.json()["connections"].as_array().unwrap().clone()
}

fn user_ids(srv_users: &Value) -> Vec<String> {
    srv_users["users"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["userId"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn an_administrator_creates_a_helper_and_removes_it() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, papa) = family(&srv).await;
    assert_eq!(get(&srv.url("/v1/hello")).await.json()["mcp"], true);

    // Only an administrator creates a helper.
    let res = papa.send(&srv, "POST", "/v1/mcp", Some(&helper_body("Помощник"))).await;
    assert_eq!(res.status, 403, "{}", text(&res));
    assert_eq!(res.json()["error"], "not_admin");

    let res = mama
        .send(&srv, "POST", "/v1/mcp", Some(&helper_body("  Помощник ")))
        .await;
    assert_eq!(res.status, 201, "{}", text(&res));
    let j = res.json();
    let token = j["token"].as_str().unwrap().to_string();
    assert!(token.starts_with("fcm_"), "{token}");
    let conn = &j["connection"];
    let id = conn["id"].as_str().unwrap().to_string();
    let helper = conn["userId"].as_str().unwrap().to_string();
    assert_eq!(conn["name"], "Помощник");
    assert_eq!(conn["mode"], "helper");
    assert_eq!(conn["levels"], json!(["read", "write"]));
    assert_eq!(conn["createdBy"], mama.user.to_string());
    assert_eq!(conn["mine"], true);
    assert_eq!(conn["active"], true);
    // Neither the seed nor the token hash ever leaves the server.
    assert!(conn.get("seed").is_none() && conn.get("tokenHash").is_none());

    // The helper is an ordinary member of the family, named as asked, and the
    // family is told that the server holds this identity's key.
    let users = papa.get(&srv, "/v1/users").await.json();
    assert!(user_ids(&users).contains(&helper), "{users}");
    for u in users["users"].as_array().unwrap() {
        let expected = if u["userId"] == helper.as_str() {
            json!("helper")
        } else {
            Value::Null
        };
        assert_eq!(u.get("mcp").cloned().unwrap_or(Value::Null), expected, "{u}");
    }
    // The token is for /mcp only: the app API does not take it.
    let res = request(
        "GET",
        &srv.url("/v1/users"),
        &[("Authorization", &format!("Bearer {token}"))],
        None,
    )
    .await;
    assert_eq!(res.status, 401);

    // An administrator sees it, another member does not.
    assert_eq!(connections(&mama.get(&srv, "/v1/mcp").await).len(), 1);
    assert!(connections(&papa.get(&srv, "/v1/mcp").await).is_empty());

    // The record on disk is private and the token is not in it.
    let file = tmp.path().join("mcp").join(format!("{id}.json"));
    let stored = std::fs::read_to_string(&file).unwrap();
    assert!(!stored.contains(&token));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    }

    // Levels and the label change in the app; a member who is not an administrator may not.
    let body = json!({ "levels": ["destructive", "read", "read"], "name": "Бот" }).to_string();
    let res = papa.send(&srv, "PUT", &format!("/v1/mcp/{id}"), Some(&body)).await;
    assert_eq!(res.status, 403, "{}", text(&res));
    let res = mama.send(&srv, "PUT", &format!("/v1/mcp/{id}"), Some(&body)).await;
    assert_eq!(res.status, 200, "{}", text(&res));
    assert_eq!(res.json()["connection"]["levels"], json!(["read", "destructive"]));
    assert_eq!(res.json()["connection"]["name"], "Бот");
    let res = mama
        .send(&srv, "PUT", &format!("/v1/mcp/{id}"), Some(r#"{"levels":["root"]}"#))
        .await;
    assert_eq!(res.status, 400, "{}", text(&res));

    // A new token replaces the old one.
    let res = mama.send(&srv, "POST", &format!("/v1/mcp/{id}/token"), None).await;
    assert_eq!(res.status, 200, "{}", text(&res));
    let token2 = res.json()["token"].as_str().unwrap().to_string();
    assert_ne!(token, token2);
    assert!(srv.state.mcp.by_token(&token).is_none());
    assert_eq!(srv.state.mcp.by_token(&token2).unwrap().file.id, id);

    // Connections survive a restart.
    let data = tmp.path().to_path_buf();
    srv.stop().await;
    let srv = open_plain(&data, Overrides::default()).await;
    let conn = srv.state.mcp.by_token(&token2).expect("loaded from disk");
    assert_eq!(conn.file.user_id.to_string(), helper);
    assert_eq!(conn.keys.user_id.to_string(), helper);

    // Deleting it removes the helper from the family and the keys from the disk.
    let res = papa.send(&srv, "DELETE", &format!("/v1/mcp/{id}"), None).await;
    assert_eq!(res.status, 403, "{}", text(&res));
    let res = mama.send(&srv, "DELETE", &format!("/v1/mcp/{id}"), None).await;
    assert_eq!(res.status, 204, "{}", text(&res));
    assert!(srv.state.mcp.by_token(&token2).is_none());
    assert!(!file.exists());
    let users = papa.get(&srv, "/v1/users").await.json();
    let gone = users["users"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["userId"] == helper.as_str())
        .is_none_or(|u| u["removed"] == true);
    assert!(gone, "{users}");
    let res = mama.send(&srv, "DELETE", &format!("/v1/mcp/{id}"), None).await;
    assert_eq!(res.status, 404);
}

#[tokio::test]
async fn a_member_connects_their_own_identity() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let mama = Person::join(&srv, "Мама", "adminCode", &srv.setup_code).await;
    let res = mama.send(&srv, "POST", "/v1/admin/invites", Some("{}")).await;
    assert_eq!(res.status, 201, "{}", text(&res));
    let papa = Person::join(&srv, "Папа", "invite", res.json()["code"].as_str().unwrap()).await;

    // The seed must be the caller's own.
    let res = papa
        .send(&srv, "POST", "/v1/mcp", Some(&me_body("Claude", &mama.seed)))
        .await;
    assert_eq!(res.status, 400, "{}", text(&res));
    assert_eq!(res.json()["error"], "seed_mismatch");
    let bad = json!({ "mode": "me", "name": "Claude", "seed": "AAAA" }).to_string();
    assert_eq!(papa.send(&srv, "POST", "/v1/mcp", Some(&bad)).await.status, 400);
    let none = json!({ "mode": "me", "name": "Claude" }).to_string();
    assert_eq!(papa.send(&srv, "POST", "/v1/mcp", Some(&none)).await.status, 400);
    assert!(srv.state.mcp.is_empty());

    // Any member connects their own identity, more than once if they like.
    let res = papa
        .send(&srv, "POST", "/v1/mcp", Some(&me_body("Claude", &papa.seed)))
        .await;
    assert_eq!(res.status, 201, "{}", text(&res));
    let j = res.json();
    let id = j["connection"]["id"].as_str().unwrap().to_string();
    assert_eq!(j["connection"]["mode"], "me");
    assert_eq!(j["connection"]["userId"], papa.user.to_string());
    let res = papa
        .send(&srv, "POST", "/v1/mcp", Some(&me_body("Второй", &papa.seed)))
        .await;
    assert_eq!(res.status, 201, "{}", text(&res));
    let other_token = res.json()["token"].as_str().unwrap().to_string();
    assert_ne!(j["token"], other_token.as_str());

    // Everyone sees that an assistant is connected to this member's identity.
    let users = mama.send(&srv, "GET", "/v1/users", None).await.json();
    let row = |id: &str| {
        users["users"]
            .as_array()
            .unwrap()
            .iter()
            .find(|u| u["userId"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(row(&papa.user.to_string())["mcp"], "me");
    assert!(row(&mama.user.to_string()).get("mcp").is_none());
    assert_eq!(papa.send(&srv, "GET", "/v1/me", None).await.json()["mcp"], "me");

    // The owner manages it. An administrator sees it and may delete it, nothing more.
    let listed = connections(&mama.send(&srv, "GET", "/v1/mcp", None).await);
    assert_eq!(listed.len(), 2);
    assert!(listed.iter().all(|c| c["mine"] == false));
    assert!(
        connections(&papa.send(&srv, "GET", "/v1/mcp", None).await)
            .iter()
            .all(|c| c["mine"] == true)
    );
    let levels = json!({ "levels": ["read"] }).to_string();
    let res = mama.send(&srv, "PUT", &format!("/v1/mcp/{id}"), Some(&levels)).await;
    assert_eq!(res.status, 403, "{}", text(&res));
    let res = mama.send(&srv, "POST", &format!("/v1/mcp/{id}/token"), None).await;
    assert_eq!(res.status, 403, "{}", text(&res));
    let res = papa.send(&srv, "PUT", &format!("/v1/mcp/{id}"), Some(&levels)).await;
    assert_eq!(res.status, 200, "{}", text(&res));
    assert_eq!(res.json()["connection"]["levels"], json!(["read"]));

    // Deleting one's own connection leaves the member in the family.
    let res = mama.send(&srv, "DELETE", &format!("/v1/mcp/{id}"), None).await;
    assert_eq!(res.status, 204, "{}", text(&res));
    assert!(srv.state.mcp.by_token(&other_token).is_some());
    let users = mama.send(&srv, "GET", "/v1/users", None).await.json();
    let me = users["users"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["userId"] == papa.user.to_string().as_str())
        .unwrap();
    assert_eq!(me["removed"], false, "{me}");
}

#[tokio::test]
async fn requests_are_validated_and_the_setting_switches_it_off() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = start(tmp.path(), Overrides::default()).await;
    let (mama, _papa) = family(&srv).await;

    assert_eq!(get(&srv.url("/v1/mcp")).await.status, 401);
    for body in [
        r#"{"mode":"helper","name":""}"#,
        r#"{"mode":"helper","name":"   "}"#,
        r#"{"mode":"helper"}"#,
        r#"{"mode":"robot","name":"x"}"#,
        r#"{"mode":"helper","name":"x","seed":"AAAA"}"#,
        r#"{"mode":"helper","name":"x","gender":"x"}"#,
        r#"{"mode":"helper","name":"x","levels":["admin"]}"#,
    ] {
        let res = mama.send(&srv, "POST", "/v1/mcp", Some(body)).await;
        assert_eq!(res.status, 400, "{body}: {}", text(&res));
    }
    // Nothing is left behind by a refused request: no record, no member.
    assert!(srv.state.mcp.is_empty());
    assert_eq!(user_ids(&mama.get(&srv, "/v1/users").await.json()).len(), 2);
    assert_eq!(mama.send(&srv, "PUT", "/v1/mcp/nope", Some("{}")).await.status, 404);
    assert_eq!(mama.send(&srv, "POST", "/v1/mcp/nope/token", None).await.status, 404);

    let res = mama
        .send(&srv, "POST", "/v1/mcp", Some(&helper_body("Помощница")))
        .await;
    assert_eq!(res.status, 201, "{}", text(&res));
    let data = tmp.path().to_path_buf();
    srv.stop().await;

    // Switched off: the API answers 404 and says so in /v1/hello; records stay on disk.
    let srv = open_plain(
        &data,
        Overrides {
            mcp: Some(false),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(get(&srv.url("/v1/hello")).await.json()["mcp"], false);
    let res = mama.get(&srv, "/v1/mcp").await;
    assert_eq!(res.status, 404, "{}", text(&res));
    assert_eq!(res.json()["error"], "mcp_disabled");
    let res = mama.send(&srv, "POST", "/v1/mcp", Some(&helper_body("Ещё"))).await;
    assert_eq!(res.status, 404, "{}", text(&res));
    assert_eq!(srv.state.mcp.len(), 1);
}
