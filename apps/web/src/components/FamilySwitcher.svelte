<script lang="ts">
  import { tick } from 'svelte';
  import FamilyEmblem from './FamilyEmblem.svelte';
  import Icon from './Icon.svelte';
  import { emblems } from '../lib/emblem.ts';
  import { app } from '../lib/app.svelte.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';

  // Which family am I in now (M5, docs/PLAN.md 7.4). M7: shown only with
  // several families, and without the family's name: a compact button with
  // the family's emblem (a coloured circle with a symbol) and a dot with the
  // unread count of the other families. Its name for screen readers is
  // "Семьи". Names appear only in the sheet it opens (and in Settings).
  let dialog: HTMLDialogElement | undefined = $state();
  let opener: HTMLButtonElement | undefined = $state();

  const account = $derived(app.account!);
  const unread = $derived(app.unreadByAccount);
  const marks = $derived(emblems(app.accounts.map((a) => a.id)));
  const elsewhere = $derived(app.accounts.filter((a) => a.id !== account.id).reduce((n, a) => n + (unread[a.id] ?? 0), 0));

  async function open(): Promise<void> {
    dialog?.showModal();
    await tick();
    dialog?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
  }

  function close(): void {
    dialog?.close();
  }

  async function choose(id: string): Promise<void> {
    close();
    if (id !== account.id) {
      await app.switchAccount(id);
      nav.reset({ name: 'list' });
    }
  }

  function go(route: 'add-family' | 'families'): void {
    close();
    nav.push({ name: route });
  }
</script>

<button
  bind:this={opener}
  class="switch"
  type="button"
  aria-haspopup="dialog"
  aria-describedby={elsewhere > 0 ? 'family-unread-elsewhere' : undefined}
  onclick={open}
  data-testid="family-switcher"
>
  {#if marks.get(account.id)}<FamilyEmblem emblem={marks.get(account.id)!} size={30} />{/if}
  <span class="visually-hidden">{t.families.switcher}</span>
  {#if elsewhere > 0}
    <span class="dot tabular" aria-hidden="true" data-testid="unread-elsewhere">{elsewhere > 99 ? '99+' : elsewhere}</span>
  {/if}
</button>
{#if elsewhere > 0}<span id="family-unread-elsewhere" class="visually-hidden">{t.families.unreadElsewhere(elsewhere)}</span>{/if}

<dialog bind:this={dialog} class="menu" aria-labelledby="families-title" onclose={() => opener?.focus()} data-testid="family-menu">
  <div class="head">
    <h2 id="families-title">{t.families.switchTitle}</h2>
    <button class="icon-btn" type="button" aria-label={t.common.close} onclick={close}><Icon name="close" /></button>
  </div>
  <ul class="list">
    {#each app.accounts as a (a.id)}
      {@const n = unread[a.id] ?? 0}
      <li>
        <button class="item" type="button" aria-current={a.id === account.id ? 'true' : undefined} onclick={() => choose(a.id)} data-testid="family-item">
          {#if marks.get(a.id)}<FamilyEmblem emblem={marks.get(a.id)!} size={32} />{/if}
          <span class="lines">
            <span class="fname">{a.familyName}</span>
            <span class="sub">{a.id === account.id ? t.families.current : new URL(a.serverUrl).host}</span>
          </span>
          {#if n > 0}
            <span class="badge tabular" aria-hidden="true">{n}</span>
            <span class="visually-hidden">{t.families.unread(n)}</span>
          {/if}
          {#if a.id === account.id}<Icon name="check" size={20} />{/if}
        </button>
      </li>
    {/each}
  </ul>
  <div class="actions">
    <button class="btn secondary" type="button" onclick={() => go('add-family')}><Icon name="plus" size={20} />{t.families.add}</button>
    {#if app.accounts.length > 1}
      <button class="link-btn" type="button" onclick={() => go('families')}>{t.families.manage}</button>
    {/if}
  </div>
</dialog>

<style>
  .switch {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: var(--touch);
    height: var(--touch);
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .switch:hover {
    background: var(--surface-2);
  }

  .dot {
    position: absolute;
    top: 0;
    right: -2px;
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    border: 2px solid var(--surface);
    border-radius: 10px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: 0.6875rem;
    font-weight: 700;
    line-height: 16px;
    text-align: center;
  }

  .badge {
    flex: 0 0 auto;
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    border-radius: 11px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: var(--text-xs);
    font-weight: 700;
    line-height: 22px;
    text-align: center;
  }

  .menu {
    width: min(24rem, calc(100vw - 1rem));
    padding: var(--sp-3);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .head h2 {
    font-size: var(--text-l);
    padding-left: var(--sp-1);
  }

  .list {
    margin: var(--sp-2) 0;
    padding: 0;
    list-style: none;
  }

  .item {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
    min-height: 56px;
    padding: var(--sp-2) var(--sp-3);
    border: 0;
    border-radius: var(--r-m);
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .item:hover {
    background: var(--surface-2);
  }

  .item[aria-current='true'] {
    background: var(--accent-soft);
    color: var(--on-accent-soft);
  }

  .lines {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
  }

  .fname {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sub {
    font-size: var(--text-s);
    color: var(--muted);
  }

  .item[aria-current='true'] .sub {
    color: var(--on-accent-soft-muted);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
  }

  .actions .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
  }
</style>
