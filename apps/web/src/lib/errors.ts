// Turns errors from the core into one plain sentence for the person.

import { isApiError, isCoreError, isNetworkError } from '@family-chat/core';
import { t } from './strings.ts';

export type JoinProblem = 'used' | 'expired' | 'invalid' | 'already' | 'code' | 'admin-taken' | null;

/** Invitation and admin-code problems that change what the screen offers. */
export function joinProblem(e: unknown): JoinProblem {
  if (isApiError(e, 'invite_used')) return 'used';
  if (isApiError(e, 'invite_expired')) return 'expired';
  if (isApiError(e, 'invalid_invite')) return 'invalid';
  if (isApiError(e, 'invalid_code')) return 'code';
  if (isCoreError(e, 'account-exists')) return 'already';
  return null;
}

export function errorText(e: unknown): string {
  switch (joinProblem(e)) {
    case 'used':
      return t.join.used;
    case 'expired':
      return t.join.expired;
    case 'invalid':
      return t.join.invalid;
    case 'code':
      return t.admin.codeWrong;
    case 'already':
      return t.join.already;
    default:
      break;
  }
  if (isNetworkError(e)) return t.errors.unreachable;
  if (isCoreError(e, 'unsupported-server')) return t.errors.unsupported;
  if (isCoreError(e, 'removed') || isApiError(e, 'removed')) return t.errors.removed;
  if (isCoreError(e, 'revoked') || isApiError(e, 'revoked')) return t.errors.revoked;
  if (isCoreError(e, 'peer-revoked')) return t.chat.peerRevokedComposer;
  if (isCoreError(e, 'not-owner')) return t.group.notOwner;
  if (isCoreError(e, 'not-member') || isApiError(e, 'not_member')) return t.group.notMember;
  if (isCoreError(e, 'owner-cannot-leave')) return t.group.leaveOwnerText;
  if (isCoreError(e, 'wrong-identity')) return t.storage.wrongIdentity;
  if (isCoreError(e, 'bad-archive')) return t.storage.badArchive;
  if (isCoreError(e, 'busy')) return t.errors.busy;
  if (isApiError(e, 'rate_limited')) return t.errors.rateLimited;
  if (isApiError(e, 'storage_full')) return t.errors.storageFull;
  if (isApiError(e, 'unexpected_response') || isApiError(e, 'not_found')) return t.errors.notServer;
  if (isApiError(e) && e.status >= 500) return t.errors.unreachable;
  const code = e instanceof Error ? (e as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && code.startsWith('phrase-')) return t.restore.badPhrase;
  if (code === 'invalid-argument') return t.errors.badName;
  if (e instanceof TypeError) return t.errors.badAddress;
  return t.errors.generic;
}

/** Short, secret-free description for the diagnostics log. */
export function describe(e: unknown): string {
  if (isApiError(e)) return `${e.status} ${e.code}`;
  if (isNetworkError(e)) return `network ${e.reason}`;
  if (isCoreError(e)) return `core ${e.code}`;
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'string' ? `${e.name} ${code}` : e.name;
  }
  return 'unknown';
}
