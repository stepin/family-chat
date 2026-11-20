//! MCP inside fcd: AI assistants reach a family's chats at `<family>/mcp`.
//!
//! A connection is an identity the server holds the keys of (its own member,
//! "helper", or a member's own identity, "me"), a bearer token and access
//! levels. The server acts for it with the client side of the protocol
//! (`crate::client`): for these identities, and only for them, the server
//! can read and write chats (docs/SECURITY-MODEL.md).

pub mod conn;
pub mod coverage;
pub mod files;
pub mod http;
pub mod manage;
pub mod media;
pub mod tools;
pub mod view;

pub use conn::{Conn, ConnFile, Level, McpStore, Mode};
