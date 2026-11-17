//! Web Push: payload encryption (RFC 8291, `aes128gcm` from RFC 8188) and
//! VAPID authorization (RFC 8292), sent with a small rustls HTTP client.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use hkdf::Hkdf;
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use p256::ecdsa::SigningKey;
use p256::ecdsa::signature::Signer;
use p256::{PublicKey, SecretKey};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// Record size written into the `aes128gcm` header. A single record is used.
const RECORD_SIZE: u32 = 4096;
/// Largest plaintext that fits into one record (RFC 8291 section 4: push
/// services must accept 4096 octets of body; header is 86, tag 16, delimiter 1).
pub const MAX_PLAINTEXT: usize = 4096 - 86 - 16 - 1;

#[derive(Debug)]
pub enum PushError {
    Subscription(&'static str),
    TooLarge,
    Transport(String),
}

impl std::fmt::Display for PushError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Subscription(m) => write!(f, "invalid subscription: {m}"),
            Self::TooLarge => f.write_str("payload too large"),
            Self::Transport(m) => write!(f, "push service request failed: {m}"),
        }
    }
}

impl std::error::Error for PushError {}

/// Browser push subscription as returned by `PushSubscription.toJSON()`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Subscription {
    pub endpoint: String,
    pub keys: SubscriptionKeys,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

/// VAPID key pair (P-256). Stored in `vapid.json`.
#[derive(Clone)]
pub struct VapidKey {
    secret: SecretKey,
}

#[derive(Serialize, Deserialize)]
pub struct VapidFile {
    /// Uncompressed public key, base64url (this is `applicationServerKey`).
    #[serde(rename = "publicKey")]
    pub public_key: String,
    /// Raw 32-byte private scalar, base64url.
    #[serde(rename = "privateKey")]
    pub private_key: String,
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("operating system random number generator failed");
    buf
}

fn random_secret_key() -> SecretKey {
    loop {
        if let Ok(k) = SecretKey::from_slice(&random_bytes::<32>()) {
            return k;
        }
    }
}

impl VapidKey {
    pub fn generate() -> Self {
        Self {
            secret: random_secret_key(),
        }
    }

    pub fn from_file(f: &VapidFile) -> Result<Self, String> {
        let raw = B64.decode(f.private_key.trim()).map_err(|e| e.to_string())?;
        let secret = SecretKey::from_slice(&raw).map_err(|_| "bad private key".to_string())?;
        let k = Self { secret };
        if k.public_key_b64() != f.public_key.trim() {
            return Err("public key does not match private key".into());
        }
        Ok(k)
    }

    pub fn to_file(&self) -> VapidFile {
        VapidFile {
            public_key: self.public_key_b64(),
            private_key: B64.encode(self.secret.to_bytes()),
        }
    }

    pub fn public_key_bytes(&self) -> Vec<u8> {
        self.secret.public_key().to_sec1_bytes().into_vec()
    }

    pub fn public_key_b64(&self) -> String {
        B64.encode(self.public_key_bytes())
    }

    /// `Authorization` header value for a push endpoint (RFC 8292).
    pub fn authorization(&self, endpoint: &str, subject: &str, now: SystemTime) -> Result<String, PushError> {
        let aud = origin_of(endpoint).ok_or(PushError::Subscription("endpoint is not an absolute URL"))?;
        let exp = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() + 12 * 3600;
        let header = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = B64.encode(serde_json::json!({ "aud": aud, "exp": exp, "sub": subject }).to_string());
        let signing_input = format!("{header}.{claims}");
        let key = SigningKey::from(&self.secret);
        let sig: p256::ecdsa::Signature = key.sign(signing_input.as_bytes());
        let jwt = format!("{signing_input}.{}", B64.encode(sig.to_bytes()));
        Ok(format!("vapid t={jwt}, k={}", self.public_key_b64()))
    }
}

/// `scheme://host[:port]` of an absolute URL, without path.
pub fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let host = rest.split(['/', '?', '#']).next()?;
    if host.is_empty() || host.contains('@') {
        return None;
    }
    Some(format!("{scheme}://{host}"))
}

/// Encrypts `plaintext` for a subscription (RFC 8291), returning the
/// `aes128gcm` body. Random ephemeral key and salt.
pub fn encrypt(ua_public: &[u8], auth_secret: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, PushError> {
    encrypt_with(
        ua_public,
        auth_secret,
        plaintext,
        &random_secret_key(),
        &random_bytes::<16>(),
    )
}

/// Deterministic core of [`encrypt`], exposed for the RFC 8291 test vector.
pub fn encrypt_with(
    ua_public: &[u8],
    auth_secret: &[u8],
    plaintext: &[u8],
    as_secret: &SecretKey,
    salt: &[u8; 16],
) -> Result<Vec<u8>, PushError> {
    if plaintext.len() > MAX_PLAINTEXT {
        return Err(PushError::TooLarge);
    }
    if auth_secret.len() != 16 {
        return Err(PushError::Subscription("auth secret must be 16 bytes"));
    }
    let ua_key = PublicKey::from_sec1_bytes(ua_public).map_err(|_| PushError::Subscription("bad p256dh key"))?;
    let ua_public = ua_key.to_sec1_bytes();
    if ua_public.len() != 65 {
        return Err(PushError::Subscription("bad p256dh key"));
    }
    let as_public = as_secret.public_key().to_sec1_bytes();
    let shared = p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua_key.as_affine());

    // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" 0x00 ua_public as_public, 32)
    let mut key_info = Vec::with_capacity(14 + 65 + 65);
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(&ua_public);
    key_info.extend_from_slice(&as_public);
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth_secret), shared.raw_secret_bytes())
        .expand(&key_info, &mut ikm)
        .expect("valid HKDF length");

    let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .expect("valid HKDF length");
    let mut nonce = [0u8; 12];
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .expect("valid HKDF length");

    let mut record = Vec::with_capacity(plaintext.len() + 1);
    record.extend_from_slice(plaintext);
    record.push(0x02); // last-record padding delimiter
    let cipher = Aes128Gcm::new_from_slice(&cek).expect("16-byte key");
    let nonce = Nonce::try_from(&nonce[..]).expect("12-byte nonce");
    let ciphertext = cipher
        .encrypt(&nonce, record.as_slice())
        .map_err(|_| PushError::TooLarge)?;

    let mut out = Vec::with_capacity(86 + ciphertext.len());
    out.extend_from_slice(salt);
    out.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    out.push(as_public.len() as u8);
    out.extend_from_slice(&as_public);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Result of one delivery attempt.
#[derive(Debug, Clone, Serialize)]
pub struct PushOutcome {
    /// HTTP status of the push service (201 means accepted).
    pub status: u16,
    /// Push service host, for the report (the full endpoint is a capability URL).
    pub service: String,
    /// First bytes of the push service response body, if it was an error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// HTTPS client for push services: rustls with bundled Mozilla roots (no
/// dependency on the system certificate store, which many routers lack).
#[derive(Clone)]
pub struct PushClient {
    client: Client<hyper_rustls::HttpsConnector<HttpConnector>, Full<Bytes>>,
    subject: String,
    timeout: Duration,
}

/// HTTPS (or plain HTTP) connector with rustls and the bundled Mozilla roots.
/// Shared by Web Push and the Telegram client.
pub fn https_connector() -> hyper_rustls::HttpsConnector<HttpConnector> {
    let tls = rustls::ClientConfig::builder_with_provider(rustls::crypto::ring::default_provider().into())
        .with_safe_default_protocol_versions()
        .expect("rustls protocol versions")
        .with_root_certificates(rustls::RootCertStore::from_iter(
            webpki_roots::TLS_SERVER_ROOTS.iter().cloned(),
        ))
        .with_no_client_auth();
    hyper_rustls::HttpsConnectorBuilder::new()
        .with_tls_config(tls)
        .https_or_http()
        .enable_http1()
        .build()
}

impl PushClient {
    pub fn new(subject: String) -> Self {
        Self {
            client: Client::builder(TokioExecutor::new()).build(https_connector()),
            subject,
            timeout: Duration::from_secs(20),
        }
    }

    pub async fn send(&self, vapid: &VapidKey, sub: &Subscription, payload: &[u8]) -> Result<PushOutcome, PushError> {
        let ua_public = B64
            .decode(sub.keys.p256dh.trim_end_matches('='))
            .map_err(|_| PushError::Subscription("p256dh is not base64url"))?;
        let auth = B64
            .decode(sub.keys.auth.trim_end_matches('='))
            .map_err(|_| PushError::Subscription("auth is not base64url"))?;
        let body = encrypt(&ua_public, &auth, payload)?;
        let authorization = vapid.authorization(&sub.endpoint, &self.subject, SystemTime::now())?;
        let uri: hyper::Uri = sub
            .endpoint
            .parse()
            .map_err(|_| PushError::Subscription("bad endpoint URL"))?;
        let service = uri.host().unwrap_or_default().to_string();
        let req = hyper::Request::post(uri)
            .header("TTL", "300")
            .header("Urgency", "high")
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            .header("Authorization", authorization)
            .body(Full::new(Bytes::from(body)))
            .map_err(|e| PushError::Transport(e.to_string()))?;
        let res = tokio::time::timeout(self.timeout, self.client.request(req))
            .await
            .map_err(|_| PushError::Transport("timeout".into()))?
            .map_err(|e| PushError::Transport(error_chain(&e)))?;
        let status = res.status().as_u16();
        let detail = if res.status().is_success() {
            None
        } else {
            let bytes = tokio::time::timeout(Duration::from_secs(5), res.into_body().collect())
                .await
                .ok()
                .and_then(|r| r.ok())
                .map(|b| b.to_bytes())
                .unwrap_or_default();
            let text = String::from_utf8_lossy(&bytes[..bytes.len().min(300)]).into_owned();
            Some(text)
        };
        Ok(PushOutcome {
            status,
            service,
            detail,
        })
    }
}

fn error_chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut cur = e.source();
    while let Some(c) = cur {
        s.push_str(": ");
        s.push_str(&c.to_string());
        cur = c.source();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::VerifyingKey;
    use p256::ecdsa::signature::Verifier;

    fn d(s: &str) -> Vec<u8> {
        B64.decode(s.split_whitespace().collect::<String>()).unwrap()
    }

    /// RFC 8291, section 5 and appendix A.
    #[test]
    fn rfc8291_test_vector() {
        let plaintext = b"When I grow up, I want to be a watermelon";
        let auth = d("BTBZMqHH6r4Tts7J_aSIgg");
        let ua_public = d("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        let as_private = SecretKey::from_slice(&d("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        let salt: [u8; 16] = d("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let expected = d("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
             mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
             pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
        let out = encrypt_with(&ua_public, &auth, plaintext, &as_private, &salt).unwrap();
        // The RFC example says Content-Length: 145; the body it shows is 144 octets.
        assert_eq!(expected.len(), 144);
        assert_eq!(B64.encode(&out), B64.encode(&expected));
    }

    #[test]
    fn rejects_oversized_payload_and_bad_keys() {
        let ua = VapidKey::generate().public_key_bytes();
        assert!(matches!(
            encrypt(&ua, &[0; 16], &vec![0; MAX_PLAINTEXT + 1]),
            Err(PushError::TooLarge)
        ));
        assert!(encrypt(&ua, &[0; 16], &vec![0; MAX_PLAINTEXT]).unwrap().len() <= 4096);
        assert!(encrypt(&ua, &[0; 15], b"x").is_err());
        assert!(encrypt(&[4; 65], &[0; 16], b"x").is_err());
    }

    #[test]
    fn vapid_jwt_is_valid_es256() {
        let k = VapidKey::generate();
        let back = VapidKey::from_file(&k.to_file()).unwrap();
        assert_eq!(back.public_key_b64(), k.public_key_b64());

        let now = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let auth = k
            .authorization("https://push.example.net:8443/p/abc?x=1", "mailto:a@example.com", now)
            .unwrap();
        let rest = auth.strip_prefix("vapid t=").unwrap();
        let (jwt, key) = rest.split_once(", k=").unwrap();
        assert_eq!(key, k.public_key_b64());
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: serde_json::Value = serde_json::from_slice(&B64.decode(parts[0]).unwrap()).unwrap();
        assert_eq!(header["alg"], "ES256");
        let claims: serde_json::Value = serde_json::from_slice(&B64.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://push.example.net:8443");
        assert_eq!(claims["sub"], "mailto:a@example.com");
        assert_eq!(claims["exp"], 1_700_000_000u64 + 12 * 3600);
        let vk = VerifyingKey::from_sec1_bytes(&k.public_key_bytes()).unwrap();
        let sig = p256::ecdsa::Signature::from_slice(&B64.decode(parts[2]).unwrap()).unwrap();
        vk.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig)
            .unwrap();
    }

    #[test]
    fn origin_parsing() {
        assert_eq!(
            origin_of("https://fcm.googleapis.com/fcm/send/x").as_deref(),
            Some("https://fcm.googleapis.com")
        );
        assert_eq!(
            origin_of("https://web.push.apple.com").as_deref(),
            Some("https://web.push.apple.com")
        );
        assert_eq!(origin_of("https://user@evil/x"), None);
        assert_eq!(origin_of("file:///x"), None);
    }
}
