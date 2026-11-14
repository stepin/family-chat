// Wording of the service lines of a group (created, renamed, added, left,
// removed, ownership transferred) from the core's ServiceEntry.

import type { ServiceEntry } from '@family-chat/core';
import { joinNames } from './names.ts';

export interface ServiceNames {
  /** My userId. */
  readonly me: string;
  /** Display name of a member ("Без имени" when unknown). */
  nameOf(userId: string): string;
}

function who(id: string, n: ServiceNames): string {
  return id === n.me ? 'Вы' : n.nameOf(id);
}

/** Objects of a sentence: "вас" for me, names otherwise. */
function whom(ids: readonly string[], n: ServiceNames): string {
  const names = ids.map((id) => (id === n.me ? 'вас' : n.nameOf(id)));
  return joinNames(names);
}

/** Verb with "Вы" (plural form) or with a name ("добавил(а)"). */
function verb(id: string, n: ServiceNames, you: string, other: string): string {
  return id === n.me ? you : other;
}

/** One service line. Names are plain text (rendered as text nodes). */
export function serviceText(e: ServiceEntry, n: ServiceNames): string {
  switch (e.type) {
    case 'created':
      return `${who(e.by, n)} ${verb(e.by, n, 'создали', 'создал(а)')} группу «${e.name}»`;
    case 'joined':
      return e.by && e.by !== n.me ? `${n.nameOf(e.by)} добавил(а) вас в группу` : 'Вас добавили в группу';
    case 'renamed':
      return `${who(e.by, n)} ${verb(e.by, n, 'переименовали', 'переименовал(а)')} группу в «${e.name}»`;
    case 'added':
      return `${who(e.by, n)} ${verb(e.by, n, 'добавили', 'добавил(а)')} ${whom(e.userIds, n)}`;
    case 'left':
      return e.userId === n.me ? 'Вы вышли из группы' : `${n.nameOf(e.userId)} вышел(а) из группы`;
    case 'removed':
      return `${who(e.by, n)} ${verb(e.by, n, 'удалили', 'удалил(а)')} из группы ${whom(e.userIds, n)}`;
    case 'owner':
      return `${who(e.by, n)} ${verb(e.by, n, 'передали', 'передал(а)')} владение группой. Новый владелец: ${
        e.userId === n.me ? 'вы' : n.nameOf(e.userId)
      }`;
    case 'you-removed':
      return 'Вас удалили из группы. Вы больше не участник';
    case 'you-left':
      return 'Вы вышли из группы';
  }
}
