//! The client side of the protocol (docs/PROTOCOL.md) in Rust: what an MCP
//! identity needs to read and write chats from inside the server.
//!
//! The reference implementation is `packages/protocol` (TypeScript, used by
//! the app). Both are checked against the same vectors in `docs/vectors/`
//! (`server/tests/client_vectors.rs`); a change of the protocol changes the
//! document, the vectors and both implementations together.

pub mod blob;
pub mod bytes;
pub mod dm;
pub mod error;
pub mod event;
pub mod group;
pub mod hpke;
pub mod json;
pub mod keys;
pub mod payload;
pub mod seal;

pub use error::{Code, ProtoError};
pub use keys::IdentityKeys;
