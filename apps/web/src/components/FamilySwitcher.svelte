<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';

  // Which family am I in now (M5, docs/PLAN.md 7.4): the family name in the
  // chat list header is a button; it opens the list of families on this
  // device with their unread counts, and "add a family". A dot with a count
  // shows unread messages in the other families.
  let dialog: HTMLDialogElement | undefined = $state();
  let opener: HTMLButtonElement | undefined = $state();

  const account = $derived(app.account!);
  const unread = $derived(app.unreadByAccount);
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

<h1 id="list-title" class="family">
  <button bind:this={opener} class="switch" type="button" aria-haspopup="dialog" aria-label={t.families.switcher(account.familyName)} onclick={open} data-testid="family-switcher">
    <span class="name">{account.familyName}</span>
    <span class="chev"><Icon name="down" size={18} /></span>
    {#if elsewhere > 0}
      <span class="dot tabular" aria-hidden="true" data-testid="unread-elsewhere">{elsewhere}</span>
      <span class="visually-hidden">{t.families.unreadElsewhere(elsewhere)}</span>
    {/if}
  </button>
</h1>

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
  .family {
    min-width: 0;
    flex: 1 1 auto;
  }

  .switch {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    max-width: 100%;
    min-height: var(--touch);
    padding: 0 var(--sp-2);
    border: 0;
    border-radius: var(--r-m);
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .switch:hover {
    background: var(--surface-2);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chev {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--muted);
  }

  .dot,
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
