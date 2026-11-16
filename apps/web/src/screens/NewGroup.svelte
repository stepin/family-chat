<script lang="ts">
  import { onMount } from 'svelte';
  import MemberChecklist from '../components/MemberChecklist.svelte';
  import Page from '../components/Page.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { errorText } from '../lib/errors.ts';
  import { displayNames } from '../lib/names.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';

  // "Новая группа": name and members; I become the
  // owner. Also opened from a frozen group with its members preselected.
  let { members: preselected = [], title = '' }: { members?: readonly string[]; title?: string } = $props();

  const account = $derived(app.account!);
  const names = $derived(displayNames(app.members.filter((m) => !m.isMe), t.common.unknownName));
  const candidates = $derived(
    app.members
      .filter((m) => !m.isMe && !m.removed && !m.revoked)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'ru')),
  );
  // svelte-ignore state_referenced_locally
  let name = $state(title);
  // svelte-ignore state_referenced_locally
  let selected = $state<string[]>([...preselected]);
  let busy = $state(false);
  let error = $state<string | null>(null);

  onMount(() => {
    void app.core.refreshMembers(account.id).catch(() => undefined);
  });

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    if (selected.length === 0) {
      error = t.newGroup.needMembers;
      return;
    }
    busy = true;
    error = null;
    try {
      const chatId = await app.core.createGroup(account.id, name.trim(), selected);
      nav.openChat(account.id, chatId, true);
    } catch (err) {
      error = errorText(err);
      app.log('warn', 'group', 'creating a group failed', err);
    } finally {
      busy = false;
    }
  }
</script>

<Page title={t.newGroup.title} onback={() => nav.back()}>
  <form class="stack" onsubmit={submit} novalidate>
    <div class="field">
      <label for="group-name">{t.newGroup.nameLabel}</label>
      <input id="group-name" class="input" type="text" maxlength="64" aria-describedby="group-name-hint" bind:value={name} />
      <span id="group-name-hint" class="hint">{t.newGroup.nameHint}</span>
    </div>
    <div class="field">
      <span class="label" id="group-members-label">{t.newGroup.membersLabel}</span>
      <span class="hint">{t.newGroup.membersHint}</span>
      <MemberChecklist accountId={account.id} members={candidates} {names} bind:selected label={t.newGroup.membersLabel} />
      <span class="hint tabular" aria-live="polite">{t.newGroup.selected(selected.length)}</span>
    </div>
    {#if error}<p class="error-text" role="alert">{error}</p>{/if}
    <button class="btn block" type="submit" disabled={busy || name.trim() === ''}>{busy ? t.newGroup.creating : t.newGroup.create}</button>
  </form>
</Page>
