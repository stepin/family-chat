<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { isApiError, MCP_LEVELS, type McpConnection, type McpLevel } from '@family-chat/core';
  import Page from '../components/Page.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { copyText } from '../lib/clipboard.ts';
  import { errorText } from '../lib/errors.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';

  // AI assistants: MCP connections of this family (docs/MCP.md). An
  // administrator creates helpers; any member may connect their own identity,
  // after reading what handing the key to the server means. Access levels are
  // changed here and nowhere else. A token is shown once and kept nowhere on
  // the device: leaving the screen forgets it.
  const account = $derived(app.account!);

  let enabled = $state<boolean | null>(null);
  let endpoint = $state('');
  let list = $state<McpConnection[]>([]);
  let loaded = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let status = $state<string | null>(null);

  /** The token just issued: shown until the person hides it or leaves. */
  let issued = $state<{ name: string; token: string } | null>(null);
  let helperName = $state(t.assistants.helperNameDefault);
  let meName = $state(t.assistants.meNameDefault);

  let confirmMe: HTMLDialogElement | undefined = $state();
  let understood = $state(false);
  let confirmRemove: HTMLDialogElement | undefined = $state();
  let removing = $state<McpConnection | null>(null);
  let opener: HTMLElement | null = null;

  const command = $derived(
    issued ? `claude mcp add --transport http family-chat ${endpoint} --header "Authorization: Bearer ${issued.token}"` : '',
  );

  function problem(e: unknown): string {
    if (isApiError(e, 'mcp_disabled')) return t.assistants.off;
    if (isApiError(e, 'too_many')) return t.assistants.tooMany;
    if (isApiError(e, 'not_admin')) return t.assistants.adminOnly;
    const text = errorText(e);
    return text === t.errors.generic || text === t.errors.notServer ? t.assistants.failed : text;
  }

  async function load(): Promise<void> {
    try {
      list = await app.core.assistants.list(account.id);
      enabled = true;
    } catch (e) {
      if (isApiError(e, 'mcp_disabled') || isApiError(e, 'not_found')) enabled = false;
      else error = problem(e);
      app.log('warn', 'assistants', 'listing connections failed', e);
    } finally {
      loaded = true;
    }
  }

  onMount(() => {
    void app.core.assistants.endpoint(account.id).then((u) => (endpoint = u));
    void load();
    // The token is not kept: leaving the screen forgets it.
    return () => (issued = null);
  });

  function kind(c: McpConnection): string {
    if (c.mode === 'helper') return t.assistants.kindHelper;
    if (c.userId === account.userId) return t.assistants.kindMe;
    return t.assistants.kindMember(app.members.find((m) => m.userId === c.userId)?.name ?? t.common.unknownName);
  }

  async function show(name: string, token: string): Promise<void> {
    issued = { name, token };
    await load();
    // The token panel replaces what was there: the focus goes to it, so a screen reader hears it.
    await tick();
    document.getElementById('assistant-token-title')?.focus();
  }

  async function createHelper(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    busy = true;
    error = null;
    status = null;
    try {
      const made = await app.core.assistants.createHelper(account.id, helperName);
      await show(made.connection.name, made.token);
    } catch (err) {
      error = problem(err);
      app.log('warn', 'assistants', 'creating a helper failed', err);
    } finally {
      busy = false;
    }
  }

  function askMe(e: SubmitEvent): void {
    e.preventDefault();
    opener = (e.submitter as HTMLElement | null) ?? null;
    understood = false;
    error = null;
    confirmMe?.showModal();
  }

  async function connectMe(): Promise<void> {
    if (!understood || busy) return;
    busy = true;
    error = null;
    status = null;
    try {
      const made = await app.core.assistants.connectMe(account.id, meName);
      confirmMe?.close();
      await show(made.connection.name, made.token);
    } catch (err) {
      error = problem(err);
      app.log('warn', 'assistants', 'connecting my identity failed', err);
    } finally {
      busy = false;
    }
  }

  async function toggle(c: McpConnection, level: McpLevel, on: boolean): Promise<void> {
    error = null;
    status = null;
    const levels = MCP_LEVELS.filter((l) => (l === level ? on : c.levels.includes(l)));
    try {
      const next = await app.core.assistants.update(account.id, c.id, { levels });
      list = list.map((x) => (x.id === next.id ? next : x));
      status = t.assistants.levelsSaved;
    } catch (err) {
      error = problem(err);
      app.log('warn', 'assistants', 'changing access levels failed', err);
      // The checkbox goes back to what the server has.
      await load();
    }
  }

  async function newToken(c: McpConnection): Promise<void> {
    if (busy) return;
    busy = true;
    error = null;
    status = null;
    try {
      await show(c.name, await app.core.assistants.newToken(account.id, c.id));
    } catch (err) {
      error = problem(err);
      app.log('warn', 'assistants', 'issuing a new token failed', err);
    } finally {
      busy = false;
    }
  }

  function askRemove(e: MouseEvent, c: McpConnection): void {
    opener = e.currentTarget as HTMLElement;
    removing = c;
    error = null;
    confirmRemove?.showModal();
  }

  async function remove(): Promise<void> {
    const c = removing;
    if (!c || busy) return;
    busy = true;
    error = null;
    try {
      await app.core.assistants.remove(account.id, c.id);
      confirmRemove?.close();
      if (issued?.name === c.name) issued = null;
      status = t.assistants.removed;
      await load();
    } catch (err) {
      error = problem(err);
      app.log('warn', 'assistants', 'deleting a connection failed', err);
    } finally {
      busy = false;
    }
  }

  async function copy(text: string): Promise<void> {
    status = (await copyText(text)) ? t.common.copied : t.common.copyFailed;
  }
</script>

<Page title={t.assistants.title} onback={() => nav.back()}>
  <section class="section" aria-label={t.assistants.title}>
    <p>{t.assistants.lead}</p>
    {#if enabled === false}
      <p class="notice" role="status" data-testid="assistants-off">{t.assistants.off}</p>
    {/if}
  </section>

  {#if enabled}
    <section class="section" aria-labelledby="as-trust">
      <h2 id="as-trust">{t.assistants.trustTitle}</h2>
      <ul class="points">
        {#each t.assistants.trustPoints as p, i (i)}<li>{p}</li>{/each}
      </ul>
    </section>

    {#if issued}
      <section class="section issued" aria-labelledby="assistant-token-title" data-testid="assistant-token">
        <h2 id="assistant-token-title" tabindex="-1">{t.assistants.tokenTitle(issued.name)}</h2>
        <p>{t.assistants.tokenLead}</p>
        <div class="field">
          <label for="as-endpoint">{t.assistants.endpointLabel}</label>
          <input id="as-endpoint" class="input mono" type="text" readonly value={endpoint} data-testid="assistant-endpoint" />
        </div>
        <div class="field">
          <label for="as-token">{t.assistants.tokenLabel}</label>
          <input id="as-token" class="input mono" type="text" readonly value={issued.token} autocomplete="off" data-testid="assistant-token-value" />
        </div>
        <div class="row wrap">
          <button class="btn" type="button" onclick={() => copy(issued!.token)}>{t.assistants.copyToken}</button>
          <button class="btn secondary" type="button" onclick={() => copy(endpoint)}>{t.assistants.copyEndpoint}</button>
        </div>
        <div class="field">
          <label for="as-command">{t.assistants.commandLabel}</label>
          <textarea id="as-command" class="input mono" readonly rows="3" data-testid="assistant-command">{command}</textarea>
        </div>
        <div class="row wrap">
          <button class="btn secondary" type="button" onclick={() => copy(command)}>{t.assistants.copyCommand}</button>
          <button class="btn secondary" type="button" onclick={() => (issued = null)}>{t.assistants.tokenDone}</button>
        </div>
      </section>
    {/if}

    {#if status}<p class="status" role="status">{status}</p>{/if}
    {#if error && !confirmMe?.open && !confirmRemove?.open}<p class="error-text" role="alert">{error}</p>{/if}

    <section class="section" aria-labelledby="as-list">
      <h2 id="as-list">{t.assistants.listTitle}</h2>
      {#if !loaded}
        <p class="muted">{t.common.loading}</p>
      {:else if list.length === 0}
        <p class="muted" data-testid="assistants-none">{t.assistants.none}</p>
      {:else}
        <ul class="conns">
          {#each list as c (c.id)}
            <li class="conn" data-testid="assistant" data-mode={c.mode}>
              <h3>{c.name}</h3>
              <p class="muted small">{kind(c)}</p>
              {#if !c.active}<p class="notice error small">{t.assistants.inactive}</p>{/if}
              <fieldset class="levels" disabled={!c.mine}>
                <legend>{t.assistants.levelsTitle}</legend>
                {#each MCP_LEVELS as level (level)}
                  <label class="level">
                    <input
                      type="checkbox"
                      checked={c.levels.includes(level)}
                      data-level={level}
                      onchange={(e) => toggle(c, level, e.currentTarget.checked)}
                    />
                    <span>
                      <span class="name">{t.assistants.levels[level].name}</span>
                      <span class="sub">{t.assistants.levels[level].text}</span>
                    </span>
                  </label>
                {/each}
              </fieldset>
              {#if !c.mine}<p class="muted small">{t.assistants.notMine}</p>{/if}
              <div class="row wrap">
                {#if c.mine}
                  <button class="btn secondary small" type="button" disabled={busy} title={t.assistants.newTokenHint} onclick={() => newToken(c)}>
                    {t.assistants.newToken}
                  </button>
                {/if}
                {#if c.mine || account.admin}
                  <button class="btn danger small" type="button" disabled={busy} data-testid="assistant-remove" onclick={(e) => askRemove(e, c)}>
                    {t.assistants.remove}
                  </button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="section" aria-labelledby="as-helper">
      <h2 id="as-helper">{t.assistants.addHelperTitle}</h2>
      <p>{t.assistants.addHelperLead}</p>
      {#if account.admin}
        <form class="stack" onsubmit={createHelper}>
          <div class="field">
            <label for="as-helper-name">{t.assistants.helperNameLabel}</label>
            <input id="as-helper-name" class="input" type="text" maxlength="64" required bind:value={helperName} />
          </div>
          <button class="btn" type="submit" disabled={busy} data-testid="create-helper">
            {busy ? t.assistants.creating : t.assistants.createHelper}
          </button>
        </form>
      {:else}
        <p class="muted">{t.assistants.adminOnly}</p>
      {/if}
    </section>

    <section class="section" aria-labelledby="as-me">
      <h2 id="as-me">{t.assistants.addMeTitle}</h2>
      <p>{t.assistants.addMeLead}</p>
      <form class="stack" onsubmit={askMe}>
        <div class="field">
          <label for="as-me-name">{t.assistants.meNameLabel}</label>
          <input id="as-me-name" class="input" type="text" maxlength="64" required bind:value={meName} />
        </div>
        <button class="btn secondary" type="submit" disabled={busy} data-testid="connect-me">{t.assistants.connectMe}</button>
      </form>
    </section>
  {/if}
</Page>

<dialog bind:this={confirmMe} aria-labelledby="as-me-title" onclose={() => opener?.focus()}>
  <div class="stack">
    <h2 id="as-me-title">{t.assistants.confirmMeTitle}</h2>
    <ul class="points">
      {#each t.assistants.confirmMePoints as p, i (i)}<li>{p}</li>{/each}
    </ul>
    <label class="check">
      <input type="checkbox" bind:checked={understood} data-testid="connect-me-understood" />
      <span>{t.assistants.confirmMeCheck}</span>
    </label>
    {#if error}<p class="error-text" role="alert">{error}</p>{/if}
    <div class="row end">
      <button class="btn secondary" type="button" disabled={busy} onclick={() => confirmMe?.close()}>{t.common.cancel}</button>
      <button class="btn" type="button" disabled={!understood || busy} data-testid="connect-me-confirm" onclick={connectMe}>
        {busy ? t.assistants.creating : t.assistants.confirmMeButton}
      </button>
    </div>
  </div>
</dialog>

<dialog bind:this={confirmRemove} aria-labelledby="as-remove-title" onclose={() => opener?.focus()}>
  <div class="stack">
    <h2 id="as-remove-title">{removing ? t.assistants.removeTitle(removing.name) : ''}</h2>
    <p>{removing?.mode === 'helper' ? t.assistants.removeHelper : t.assistants.removeMe}</p>
    {#if error}<p class="error-text" role="alert">{error}</p>{/if}
    <div class="row end">
      <button class="btn secondary" type="button" disabled={busy} onclick={() => confirmRemove?.close()}>{t.common.cancel}</button>
      <button class="btn danger" type="button" disabled={busy} data-testid="assistant-remove-confirm" onclick={remove}>{t.assistants.remove}</button>
    </div>
  </div>
</dialog>

<style>
  .points {
    margin: 0;
    padding-left: var(--sp-5);
  }

  .points li + li {
    margin-top: var(--sp-1);
  }

  .issued {
    background: var(--accent-soft);
    color: var(--on-accent-soft);
  }

  .issued textarea {
    resize: vertical;
    min-height: calc(var(--touch) * 1.5);
    overflow-wrap: anywhere;
  }

  .status {
    margin: 0;
    padding: 0 var(--sp-4);
  }

  .conns {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .conn {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding: var(--sp-4);
    border: 1px solid var(--line);
    border-radius: var(--r-m);
  }

  .conn h3,
  .conn p {
    margin: 0;
  }

  .levels {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }

  .levels legend {
    padding: 0;
    font-weight: 600;
  }

  .level,
  .check {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-3);
    min-height: var(--touch);
    padding: var(--sp-2) 0;
    cursor: pointer;
  }

  .check {
    align-items: center;
    font-weight: 600;
  }

  .level input,
  .check input {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    margin: 0;
    accent-color: var(--accent);
  }

  .level > span {
    display: flex;
    flex-direction: column;
  }

  .name {
    font-weight: 600;
  }

  .sub {
    font-size: var(--text-s);
    color: var(--muted);
  }

  .levels:disabled .level {
    cursor: default;
    opacity: 0.7;
  }

  .wrap {
    flex-wrap: wrap;
  }

  .end {
    justify-content: flex-end;
  }

  .section form .btn {
    align-self: flex-start;
  }
</style>
