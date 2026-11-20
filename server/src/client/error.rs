//! Typed errors of the protocol (docs/PROTOCOL.md, section 9). Messages never
//! contain key material, seeds, phrase words or plaintext.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    Malformed,
    TooLarge,
    InvalidArgument,
    PhraseWordCount,
    PhraseUnknownWord,
    PhraseChecksum,
    UnsupportedVersion,
    InvalidKey,
    BadSignature,
    UserIdMismatch,
    ContextMismatch,
    WrongServer,
    WrongChat,
    WrongEpoch,
    WrongKey,
    UnknownAuthor,
    SenderMismatch,
    NotOwner,
    BadChain,
    InvalidTransition,
    StateMismatch,
    WrongRecipient,
}

impl Code {
    /// The code as the document and the TypeScript implementation spell it.
    pub fn as_str(self) -> &'static str {
        match self {
            Code::Malformed => "malformed",
            Code::TooLarge => "too-large",
            Code::InvalidArgument => "invalid-argument",
            Code::PhraseWordCount => "phrase-word-count",
            Code::PhraseUnknownWord => "phrase-unknown-word",
            Code::PhraseChecksum => "phrase-checksum",
            Code::UnsupportedVersion => "unsupported-version",
            Code::InvalidKey => "invalid-key",
            Code::BadSignature => "bad-signature",
            Code::UserIdMismatch => "user-id-mismatch",
            Code::ContextMismatch => "context-mismatch",
            Code::WrongServer => "wrong-server",
            Code::WrongChat => "wrong-chat",
            Code::WrongEpoch => "wrong-epoch",
            Code::WrongKey => "wrong-key",
            Code::UnknownAuthor => "unknown-author",
            Code::SenderMismatch => "sender-mismatch",
            Code::NotOwner => "not-owner",
            Code::BadChain => "bad-chain",
            Code::InvalidTransition => "invalid-transition",
            Code::StateMismatch => "state-mismatch",
            Code::WrongRecipient => "wrong-recipient",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtoError {
    pub code: Code,
    pub message: String,
    /// 1-based word positions for `phrase-unknown-word`.
    pub positions: Vec<usize>,
}

impl fmt::Display for ProtoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for ProtoError {}

pub type Result<T> = std::result::Result<T, ProtoError>;

pub fn err(code: Code, message: impl Into<String>) -> ProtoError {
    ProtoError {
        code,
        message: message.into(),
        positions: Vec::new(),
    }
}

pub fn malformed(message: impl Into<String>) -> ProtoError {
    err(Code::Malformed, message)
}

pub fn invalid(message: impl Into<String>) -> ProtoError {
    err(Code::InvalidArgument, message)
}
