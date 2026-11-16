// Wording of the service lines of a group (created, renamed, added, left,
// removed, ownership transferred) from the core's ServiceEntry. The verb
// agrees with the gender of the person who acted (profile field, male
// when unknown); "Вы" lines do not change.

import type { ServiceEntry } from '@family-chat/core';
import type { Gender } from './i18n/forms.ts';
import { joinNames } from './names.ts';
import { t } from './strings.ts';

export interface ServiceNames {
  /** My userId. */
  readonly me: string;
  /** Display name of a member ("Без имени" when unknown). */
  nameOf(userId: string): string;
  /** Gender of a member from the profile; male when unknown. */
  genderOf?(userId: string): Gender;
}

function gender(id: string, n: ServiceNames): Gender {
  return n.genderOf?.(id) ?? 'm';
}

/** Objects of a sentence: "вас" for me, names otherwise. */
function whom(ids: readonly string[], n: ServiceNames): string {
  return joinNames(ids.map((id) => (id === n.me ? t.service.youObject : n.nameOf(id))));
}

/** One service line. Names are plain text (rendered as text nodes). */
export function serviceText(e: ServiceEntry, n: ServiceNames): string {
  const s = t.service;
  switch (e.type) {
    case 'created':
      return e.by === n.me ? s.createdByMe(e.name) : s.created(n.nameOf(e.by), gender(e.by, n), e.name);
    case 'joined':
      return e.by && e.by !== n.me ? s.joinedBy(n.nameOf(e.by), gender(e.by, n)) : s.joined;
    case 'renamed':
      return e.by === n.me ? s.renamedByMe(e.name) : s.renamed(n.nameOf(e.by), gender(e.by, n), e.name);
    case 'added':
      return e.by === n.me ? s.addedByMe(whom(e.userIds, n)) : s.added(n.nameOf(e.by), gender(e.by, n), whom(e.userIds, n));
    case 'left':
      return e.userId === n.me ? s.leftMe : s.left(n.nameOf(e.userId), gender(e.userId, n));
    case 'removed':
      return e.by === n.me ? s.removedByMe(whom(e.userIds, n)) : s.removed(n.nameOf(e.by), gender(e.by, n), whom(e.userIds, n));
    case 'owner': {
      const owner = e.userId === n.me ? s.youOwner : n.nameOf(e.userId);
      return e.by === n.me ? s.ownerByMe(owner) : s.owner(n.nameOf(e.by), gender(e.by, n), owner);
    }
    case 'you-removed':
      return s.youRemoved;
    case 'you-left':
      return s.leftMe;
  }
}
