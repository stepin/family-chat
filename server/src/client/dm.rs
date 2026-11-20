//! Direct-chat keys (docs/PROTOCOL.md, section 5):
//! `dmKey = HKDF(X25519(mySecret, peerBoxPub), "fc/v1/dm" || lp(serverId) || lp(lo) || lp(hi))`.
//! The chat with oneself uses the same formula with peer = self.

use super::bytes::{cat, lp};
use super::error::{Result, invalid};
use super::json::context_string_ok;
use super::keys::{IdentityKeys, hkdf32, x25519};
use crate::ids::UserId;

const LABEL_DM: &[u8] = b"fc/v1/dm";
const LABEL_ENC: &[u8] = b"fc/v1/enc";
/// Epoch of every direct chat.
pub const DM_EPOCH: u32 = 0;

/// Symmetric keys of one chat epoch. Holds a secret.
#[derive(Clone)]
pub struct ChatKeys {
    pub epoch: u32,
    /// AES-256-GCM key for events: `HKDF(secret, "fc/v1/enc")`.
    pub enc_key: [u8; 32],
}

/// Encryption key of an epoch secret (direct chats and groups alike).
pub fn derive_enc_key(secret: &[u8; 32]) -> [u8; 32] {
    hkdf32(secret, LABEL_ENC)
}

/// Keys of the direct chat between `me` and a peer on one server.
/// `invalid-key` when X25519 gives the all-zero secret (a low-order peer key).
pub fn derive_dm_keys(me: &IdentityKeys, peer: &UserId, peer_box_pub: &[u8; 32], server_id: &str) -> Result<ChatKeys> {
    Ok(ChatKeys {
        epoch: DM_EPOCH,
        enc_key: derive_enc_key(&derive_dm_key(me, peer, peer_box_pub, server_id)?),
    })
}

/// The direct-chat secret itself (vectors compare it).
pub fn derive_dm_key(me: &IdentityKeys, peer: &UserId, peer_box_pub: &[u8; 32], server_id: &str) -> Result<[u8; 32]> {
    if !context_string_ok(server_id) {
        return Err(invalid("serverId must be a string of 1 to 256 bytes"));
    }
    let shared = x25519(me.box_secret(), peer_box_pub)?;
    let (a, b) = (me.user_id.to_string(), peer.to_string());
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let info = cat(&[
        LABEL_DM,
        &lp(server_id.as_bytes()),
        &lp(lo.as_bytes()),
        &lp(hi.as_bytes()),
    ]);
    Ok(hkdf32(&shared, &info))
}
