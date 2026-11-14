<script lang="ts">
  import type { Member } from '@family-chat/core';
  import Avatar from './Avatar.svelte';

  // A list of relatives with check boxes (new group, adding to a group).
  let {
    accountId,
    members,
    names,
    selected = $bindable([]),
    label,
  }: {
    accountId: string;
    members: readonly Member[];
    names: Map<string, string>;
    selected?: string[];
    /** Accessible name of the list. */
    label: string;
  } = $props();

  function toggle(id: string, on: boolean): void {
    selected = on ? [...selected.filter((x) => x !== id), id] : selected.filter((x) => x !== id);
  }
</script>

<ul class="people" aria-label={label}>
  {#each members as m (m.userId)}
    <li>
      <label class="person">
        <input type="checkbox" checked={selected.includes(m.userId)} onchange={(e) => toggle(m.userId, e.currentTarget.checked)} />
        <Avatar {accountId} userId={m.userId} name={m.name} hasAvatar={!!m.avatar} size={40} />
        <span class="name">{names.get(m.userId) ?? m.name}</span>
      </label>
    </li>
  {/each}
</ul>

<style>
  .people {
    margin: 0;
    padding: 0;
    list-style: none;
    border-radius: var(--r-l);
    background: var(--surface);
    overflow: hidden;
  }

  .person {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-height: 56px;
    padding: var(--sp-2) var(--sp-4);
    border-bottom: 1px solid var(--line);
    cursor: pointer;
  }

  .people li:last-child .person {
    border-bottom: 0;
  }

  .person:hover {
    background: var(--surface-2);
  }

  input {
    width: 22px;
    height: 22px;
    accent-color: var(--accent);
  }

  .name {
    flex: 1 1 auto;
    font-weight: 600;
    font-size: var(--text-m);
  }
</style>
