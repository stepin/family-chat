<script lang="ts">
  import type { AccountView } from '@family-chat/core';
  import { app } from '../lib/app.svelte.ts';
  import { statusLine } from '../lib/status.ts';
  import { t } from '../lib/strings.ts';

  // The connection status line (docs/PLAN-v2.md 8): the main trust signal.
  let { account }: { account: AccountView } = $props();

  let busy = $state(false);
  const queued = $derived(app.outbox.filter((o) => o.accountId === account.id).length);
  const conn = $derived(
    account.status === 'removed'
      ? ({ kind: 'removed' } as const)
      : account.status === 'login-invalid' && app.connection[account.id]?.kind !== 'connected'
        ? ({ kind: 'login-invalid' } as const)
        : app.connection[account.id],
  );
  const line = $derived(statusLine(conn, account.familyName, queued));

  async function relogin(): Promise<void> {
    busy = true;
    try {
      await app.core.relogin(account.id);
    } catch (e) {
      app.notify(t.status.reloginFailed);
      app.log('warn', 'auth', 'manual re-login failed', e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="status tone-{line.tone}" role="status" data-testid="status-line">
  <span class="dot" aria-hidden="true"></span>
  <span class="text">{line.text}</span>
  {#if line.relogin}
    <button class="btn small" type="button" disabled={busy} onclick={relogin}>{t.status.relogin}</button>
  {/if}
</div>

<style>
  .status {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: 32px;
    padding: var(--sp-1) var(--sp-4);
    font-size: var(--text-s);
    color: var(--muted);
    background: var(--surface);
    border-bottom: 1px solid var(--line);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ok);
    flex: 0 0 auto;
  }

  .text {
    flex: 1 1 auto;
  }

  .tone-busy .dot {
    background: var(--muted);
  }

  .tone-warn {
    color: var(--text);
    background: var(--warn-soft);
  }

  .tone-warn .dot {
    background: var(--warn);
  }

  .tone-error {
    color: var(--text);
    background: var(--error-soft);
  }

  .tone-error .dot {
    background: var(--error);
  }
</style>
