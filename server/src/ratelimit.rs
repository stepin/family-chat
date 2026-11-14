//! Rate limit for wrong codes and signatures: at most 10 failures per minute
//! per client address (docs/PLAN-v2.md, section 7.3).

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::http::StatusCode;

use crate::error::ApiError;

pub const MAX_FAILURES: usize = 10;
pub const WINDOW: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct RateLimiter {
    failures: Mutex<HashMap<IpAddr, VecDeque<Instant>>>,
}

impl RateLimiter {
    /// `Err(429)` while the address has used up its failures.
    pub fn check(&self, ip: IpAddr) -> Result<(), ApiError> {
        self.check_at(ip, Instant::now())
    }

    pub fn fail(&self, ip: IpAddr) {
        self.fail_at(ip, Instant::now())
    }

    fn check_at(&self, ip: IpAddr, now: Instant) -> Result<(), ApiError> {
        let mut map = self.failures.lock().expect("rate limit lock");
        let Some(q) = map.get_mut(&ip) else { return Ok(()) };
        while q.front().is_some_and(|t| now.duration_since(*t) >= WINDOW) {
            q.pop_front();
        }
        if q.is_empty() {
            map.remove(&ip);
            return Ok(());
        }
        if q.len() >= MAX_FAILURES {
            let wait = WINDOW.saturating_sub(now.duration_since(q[0])).as_secs().max(1);
            let mut e = ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "too many wrong codes or signatures; try again later",
            );
            e.retry_after = Some(wait);
            return Err(e);
        }
        Ok(())
    }

    fn fail_at(&self, ip: IpAddr, now: Instant) {
        let mut map = self.failures.lock().expect("rate limit lock");
        // Keep the table small: forget addresses with only old failures.
        if map.len() > 10_000 {
            map.retain(|_, q| q.back().is_some_and(|t| now.duration_since(*t) < WINDOW));
        }
        let q = map.entry(ip).or_default();
        q.push_back(now);
        while q.len() > MAX_FAILURES {
            q.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ten_failures_per_minute() {
        let rl = RateLimiter::default();
        let ip: IpAddr = "192.0.2.1".parse().unwrap();
        let other: IpAddr = "192.0.2.2".parse().unwrap();
        let t0 = Instant::now();
        for i in 0..MAX_FAILURES {
            assert!(rl.check_at(ip, t0).is_ok(), "{i}");
            rl.fail_at(ip, t0);
        }
        let e = rl.check_at(ip, t0 + Duration::from_secs(1)).unwrap_err();
        assert_eq!(e.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(e.retry_after, Some(59));
        assert!(rl.check_at(other, t0).is_ok());
        assert!(rl.check_at(ip, t0 + WINDOW).is_ok());
    }
}
