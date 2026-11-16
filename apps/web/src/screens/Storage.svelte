<script lang="ts">
  import { onMount } from 'svelte';
  import { isCoreError } from '@family-chat/core';
  import Page from '../components/Page.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { formatBytes } from '../lib/format.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { archiveFileName, canShareFile, readWithProgress, saveBlob, shareFile, usedSpace } from '../lib/storage.ts';
  import { t } from '../lib/strings.ts';

  // Storage and archive: space used on this
  // device, whether the browser may clear it, export of the archive (with or
  // without files, progress and cancel, then a file or the share sheet),
  // import (progress, "добавлено N, пропущено M", the archive of another
  // identity), the date of the last export.
  const account = $derived(app.account!);
  let used = $state<{ usage: number; quota: number } | null>(null);
  let lastExport = $state<number | null>(null);
  let withFiles = $state(true);

  type Export =
    | { readonly state: 'idle' }
    | { readonly state: 'running'; readonly bytes: number }
    | { readonly state: 'ready'; readonly file: File }
    | { readonly state: 'error'; readonly message: string };
  let exp = $state.raw<Export>({ state: 'idle' });
  let exportCancel = false;

  type Import =
    | { readonly state: 'idle' }
    | { readonly state: 'running'; readonly percent: number }
    | { readonly state: 'done'; readonly added: number; readonly skipped: number }
    | { readonly state: 'error'; readonly message: string };
  let imp = $state.raw<Import>({ state: 'idle' });
  let importAbort: AbortController | null = null;
  let input: HTMLInputElement | undefined = $state();

  async function refresh(): Promise<void> {
    used = await usedSpace();
    lastExport = (await app.getValue<number>('lastExport')) ?? null;
    await app.refreshPersisted();
  }

  onMount(() => {
    void refresh();
    return () => {
      exportCancel = true;
      importAbort?.abort();
    };
  });

  async function startExport(): Promise<void> {
    exportCancel = false;
    exp = { state: 'running', bytes: 0 };
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const gen = app.core.exportArchive({ userId: account.userId, includeFiles: withFiles });
    try {
      for await (const chunk of gen) {
        if (exportCancel) {
          await gen.return(undefined);
          exp = { state: 'idle' };
          app.notify(t.storage.cancelled);
          return;
        }
        chunks.push(chunk);
        bytes += chunk.length;
        exp = { state: 'running', bytes };
      }
      const name = archiveFileName(app.familyLabel(account.familyName) ?? "", Date.now());
      exp = { state: 'ready', file: new File(chunks as BlobPart[], name, { type: 'application/octet-stream' }) };
    } catch (e) {
      const quota = e instanceof DOMException && e.name === 'QuotaExceededError';
      exp = { state: 'error', message: quota ? t.storage.noSpace : t.storage.exportFailed };
      app.log('warn', 'archive', 'export failed', e);
    }
  }

  async function markExported(): Promise<void> {
    lastExport = Date.now();
    await app.setValue('lastExport', lastExport);
  }

  async function save(): Promise<void> {
    if (exp.state !== 'ready') return;
    saveBlob(exp.file, exp.file.name);
    await markExported();
  }

  async function share(): Promise<void> {
    if (exp.state !== 'ready') return;
    if (await shareFile(exp.file)) await markExported();
  }

  function pickArchive(): void {
    input?.click();
  }

  async function onArchivePicked(): Promise<void> {
    const file = input?.files?.[0];
    if (input) input.value = '';
    if (!file) return;
    const abort = new AbortController();
    importAbort = abort;
    imp = { state: 'running', percent: 0 };
    try {
      const source = readWithProgress(
        file,
        (done) => (imp = { state: 'running', percent: file.size > 0 ? Math.floor((done / file.size) * 100) : 100 }),
        abort.signal,
      );
      const r = await app.core.importArchive(source);
      imp = { state: 'done', added: r.added, skipped: r.skipped };
    } catch (e) {
      if (abort.signal.aborted) {
        imp = { state: 'idle' };
        app.notify(t.storage.cancelled);
      } else {
        const message = isCoreError(e, 'wrong-identity')
          ? t.storage.wrongIdentity
          : isCoreError(e, 'bad-archive')
            ? t.storage.badArchive
            : e instanceof DOMException && e.name === 'QuotaExceededError'
              ? t.storage.noSpace
              : t.storage.importFailed;
        imp = { state: 'error', message };
      }
      app.log('warn', 'archive', 'import failed', e);
    } finally {
      importAbort = null;
      void refresh();
    }
  }

  const shareable = $derived(exp.state === 'ready' && canShareFile(exp.file));
</script>

<Page title={t.storage.title} onback={() => nav.back()}>
  <section class="section" aria-labelledby="st-space">
    <h2 id="st-space">{t.storage.title}</h2>
    <p data-testid="storage-used">{used ? t.storage.used(formatBytes(used.usage)) : t.storage.usedUnknown}</p>
    {#if app.persisted === false}
      <p class="notice warn" role="status" data-testid="storage-not-persisted">{t.storage.notPersisted}</p>
    {:else if app.persisted === true}
      <p class="muted small">{t.storage.persisted}</p>
    {/if}
    <p class="muted small" data-testid="last-export">{t.storage.lastExport(lastExport)}</p>
  </section>

  <section class="section" aria-labelledby="st-export">
    <h2 id="st-export">{t.storage.exportTitle}</h2>
    <p>{t.storage.exportLead(account.retentionDays)}</p>
    <label class="check">
      <input type="checkbox" bind:checked={withFiles} disabled={exp.state === 'running'} />
      <span>{t.storage.withFiles}</span>
    </label>
    {#if exp.state === 'running'}
      <p role="status" class="tabular">{t.storage.exporting(formatBytes(exp.bytes))}</p>
      <progress aria-label={t.storage.exportTitle}></progress>
      <button class="btn secondary" type="button" onclick={() => (exportCancel = true)}>{t.storage.cancel}</button>
    {:else if exp.state === 'ready'}
      <p role="status" data-testid="export-ready">{t.storage.exportReady(formatBytes(exp.file.size))}</p>
      <div class="row">
        <button class="btn" type="button" onclick={save}>{t.storage.save}</button>
        {#if shareable}<button class="btn secondary" type="button" onclick={share}>{t.storage.share}</button>{/if}
      </div>
    {:else}
      {#if exp.state === 'error'}<p class="error-text" role="alert">{exp.message}</p>{/if}
      <button class="btn" type="button" onclick={startExport}>{t.storage.export}</button>
    {/if}
  </section>

  <section class="section" aria-labelledby="st-import">
    <h2 id="st-import">{t.storage.importTitle}</h2>
    <p>{t.storage.importLead}</p>
    {#if imp.state === 'running'}
      <p role="status" class="tabular">{t.storage.importing(imp.percent)}</p>
      <progress max="100" value={imp.percent} aria-label={t.storage.importTitle}></progress>
      <button class="btn secondary" type="button" onclick={() => importAbort?.abort()}>{t.storage.cancel}</button>
    {:else}
      {#if imp.state === 'done'}
        <p class="notice" role="status" data-testid="import-result">{t.storage.imported(imp.added, imp.skipped)}</p>
      {:else if imp.state === 'error'}
        <p class="notice error" role="alert" data-testid="import-error">{imp.message}</p>
      {/if}
      <button class="btn secondary" type="button" onclick={pickArchive}>{t.storage.import}</button>
    {/if}
    <input
      bind:this={input}
      class="visually-hidden"
      type="file"
      accept=".fcarchive,application/octet-stream"
      tabindex="-1"
      aria-hidden="true"
      data-testid="archive-input"
      onchange={onArchivePicked}
    />
  </section>
</Page>

<style>
  .section > .btn,
  .section > .row {
    align-self: flex-start;
  }

  .check {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-height: var(--touch);
    cursor: pointer;
  }

  .check input {
    width: 22px;
    height: 22px;
    accent-color: var(--accent);
  }

  progress {
    width: 100%;
    accent-color: var(--accent);
  }
</style>
