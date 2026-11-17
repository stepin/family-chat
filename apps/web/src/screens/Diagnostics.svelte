<script lang="ts">
  import { onMount } from 'svelte';
  import { pageServerUrl } from '../lib/invite.ts';
  import type { DiagnosticEntry } from '@family-chat/core';
  import Page from '../components/Page.svelte';
  import { app, follow } from '../lib/app.svelte.ts';
  import { copyText } from '../lib/clipboard.ts';
  import { t } from '../lib/strings.ts';
  import { nav } from '../lib/nav.svelte.ts';

  // Diagnostics: the log, the outbox size, the
  // report to copy, and the device and server check pages.
  let entries = $state.raw<DiagnosticEntry[]>([]);
  let status = $state<string | null>(null);
  // Server checks run in the app for administrators ("Server check" in
  // Family and server); the /server/ page is for a server not yet set up.
  const adminAccounts = $derived(app.accounts.filter((a) => a.admin && a.status === 'active'));
  let pageCodeActive = $state(false);

  onMount(() => {
    void app.core
      .serverInfo(pageServerUrl(location))
      .then((h) => (pageCodeActive = h.adminCodeActive))
      .catch(() => undefined);
    return follow(app.core.diagnostics, (list) => (entries = [...list].reverse().slice(0, 200)));
  });

  async function openServerCheck(accountId: string): Promise<void> {
    if (app.account?.id !== accountId) await app.switchAccount(accountId);
    nav.push({ name: 'server' });
  }

  /** One line per family server: its version, or why it is unknown. */
  async function serverLines(): Promise<string[]> {
    return Promise.all(
      app.accounts.map(async (a) => {
        try {
          const h = await app.core.serverInfo(a.serverUrl);
          return `${t.settings.serverVersion(h.version, h.commit)}: ${a.serverUrl}`;
        } catch {
          return `${t.diagnostics.serverUnknown}: ${a.serverUrl}`;
        }
      }),
    );
  }

  async function copyReport(): Promise<void> {
    const report = await app.core.diagnosticsReport();
    const servers = await serverLines();
    const commit = __APP_COMMIT__ ? ` (${__APP_COMMIT__})` : '';
    const header = `Family Chat ${__APP_VERSION__}${commit}\n${servers.map((l) => `${l}\n`).join('')}${navigator.userAgent}\n\n`;
    status = (await copyText(header + report)) ? t.common.copied : t.common.copyFailed;
  }

  function time(ms: number): string {
    return new Date(ms).toLocaleString('ru-RU');
  }
</script>

<Page title={t.diagnostics.title} onback={() => nav.back()}>
  <section class="section" aria-label={t.diagnostics.title}>
    <p>{t.diagnostics.lead}</p>
    <p class="small">{t.diagnostics.outbox(app.outbox.length)}</p>
    <div class="row">
      <button class="btn" type="button" onclick={copyReport}>{t.diagnostics.copy}</button>
      <button class="btn secondary" type="button" onclick={() => app.core.clearDiagnostics()}>{t.diagnostics.clear}</button>
    </div>
    {#if status}<p role="status">{status}</p>{/if}
    {#if entries.length === 0}
      <p class="muted">{t.diagnostics.empty}</p>
    {:else}
      <ol class="log mono">
        {#each entries as e (e.id)}
          <li class="lvl-{e.level}"><span class="muted">{time(e.time)}</span> [{e.level}] {e.kind}: {e.message}</li>
        {/each}
      </ol>
    {/if}
  </section>

  <section class="section" aria-labelledby="diag-checks">
    <h2 id="diag-checks">{t.diagnostics.checks}</h2>
    <ul class="links">
      <li><a href="./device/">{t.diagnostics.deviceCheck}</a></li>
      {#each adminAccounts as a (a.id)}
        <li>
          <button class="link-btn" type="button" onclick={() => openServerCheck(a.id)}>
            {adminAccounts.length > 1 ? t.diagnostics.serverCheckOf(a.familyName) : t.diagnostics.serverCheck}
          </button>
        </li>
      {/each}
      {#if app.accounts.length === 0 || pageCodeActive}
        <li><a href="./server/">{t.diagnostics.serverCheckPage}</a></li>
      {/if}
    </ul>
    {#if app.accounts.length > 0 && adminAccounts.length === 0}
      <p class="muted small" data-testid="server-check-admin-only">{t.diagnostics.serverCheckAdminOnly}</p>
    {/if}
  </section>
</Page>

<style>
  .log {
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }

  .log li {
    padding: var(--sp-1) 0;
    border-top: 1px solid var(--line);
  }

  .lvl-error {
    color: var(--error);
  }

  .links {
    margin: 0;
    padding-left: var(--sp-5);
  }

  .links li {
    min-height: var(--touch);
    display: flex;
    align-items: center;
  }
</style>
