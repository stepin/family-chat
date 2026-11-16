<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { CheckLastPush } from '@family-chat/core';
  import NotificationSettings from './NotificationSettings.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { formatTime } from '../lib/format.ts';
  import { notifyEnv, notifyState, pushAccountOf } from '../lib/push.ts';
  import { t } from '../lib/strings.ts';
  import { describeCheckFailure, docsLink, failureFromError, type CheckMessage } from '../server/check.ts';

  // Server check for administrators (as on the /server/ page): a long request through the proxy and a test notification to this
  // device. Failures are worded by the table shared with /server/ (check.ts).
  let { accountId }: { accountId: string } = $props();

  /** The screen always waits 25 s: what proxies most often cut. */
  const WAIT_SECONDS = 25;
  const LATER_SECONDS = 30;

  const account = $derived(app.accounts.find((a) => a.id === accountId) ?? app.account!);
  const settingsPath = $derived(`${t.settings.title} → ${t.settings.family} → ${t.server.check}`);
  const pushState = $derived(notifyState(notifyEnv(), app.platform, account, pushAccountOf(app.accounts, location.origin)));

  let waiting = $state(false);
  let elapsed = $state(0);
  let waitResult = $state<{ ok: true; seconds: number } | { ok: false; msg: CheckMessage } | null>(null);
  let pushing = $state(false);
  let pushResult = $state<{ ok: true; text: string } | { ok: false; msg: CheckMessage } | null>(null);
  let last = $state<CheckLastPush | null>(null);
  let ctl: AbortController | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  const check = () => app.core.serverCheck(accountId);

  function describe(e: unknown, ms: number, longRequestSeconds?: number): CheckMessage {
    return describeCheckFailure(failureFromError(e, ms), {
      context: 'app',
      settingsPath,
      lang: app.lang,
      ...(longRequestSeconds ? { longRequestSeconds } : {}),
    });
  }

  async function loadLast(): Promise<void> {
    try {
      last = await check().lastPush();
    } catch {
      // Only a hint; the buttons still work.
    }
  }

  onMount(() => void loadLast());

  // Leaving the screen ends the long request; a scheduled notification still comes.
  onDestroy(() => {
    ctl?.abort();
    clearInterval(timer);
  });

  async function runWait(): Promise<void> {
    if (waiting) return;
    waiting = true;
    waitResult = null;
    elapsed = 0;
    ctl = new AbortController();
    const started = performance.now();
    timer = setInterval(() => (elapsed = Math.min(WAIT_SECONDS, Math.floor((performance.now() - started) / 1000))), 1000);
    try {
      await check().wait(WAIT_SECONDS, ctl.signal);
      waitResult = { ok: true, seconds: Math.round((performance.now() - started) / 1000) };
    } catch (e) {
      waitResult = { ok: false, msg: describe(e, performance.now() - started, WAIT_SECONDS) };
      app.log('warn', 'check', 'long request failed', e);
    } finally {
      clearInterval(timer);
      waiting = false;
      ctl = null;
    }
  }

  async function runPush(delaySeconds: number): Promise<void> {
    if (pushing) return;
    pushing = true;
    pushResult = null;
    const started = performance.now();
    try {
      const r = await check().push(delaySeconds);
      pushResult = { ok: true, text: r.scheduled ? t.server.checkPushScheduled(delaySeconds) : t.server.checkPushSent };
    } catch (e) {
      pushResult = { ok: false, msg: describe(e, performance.now() - started) };
      app.log('warn', 'check', 'test notification failed', e);
    } finally {
      pushing = false;
      void loadLast();
    }
  }
</script>

{#snippet failure(msg: CheckMessage)}
  <p class="error-text" role="alert">
    {msg.text}
    {#if msg.link}
      <a href={docsLink(msg.link, app.lang)} target="_blank" rel="noopener">{msg.link === 'faq' ? t.server.checkFaq : t.server.checkMore}</a>
    {/if}
  </p>
{/snippet}

<div class="stack" data-testid="server-check">
  <p class="muted small">{t.server.checkLead}</p>

  <div class="stack tight">
    <button class="btn secondary" type="button" disabled={waiting} onclick={runWait} data-testid="check-wait">
      {t.server.checkWait(WAIT_SECONDS)}
    </button>
    {#if waiting}
      <p class="muted" data-testid="check-wait-running">{t.server.checkWaiting(elapsed, WAIT_SECONDS)}</p>
    {/if}
    <div aria-live="polite">
      {#if waitResult?.ok}
        <p data-testid="check-wait-ok">{t.server.checkWaitOk(waitResult.seconds)}</p>
      {:else if waitResult}
        {@render failure(waitResult.msg)}
      {/if}
    </div>
  </div>

  <div class="stack tight">
    {#if pushState === 'allowed'}
      <button class="btn secondary" type="button" disabled={pushing} onclick={() => runPush(0)} data-testid="check-push">
        {t.server.checkPushNow}
      </button>
      <button class="btn secondary" type="button" disabled={pushing} onclick={() => runPush(LATER_SECONDS)}>
        {t.server.checkPushLater(LATER_SECONDS)}
      </button>
    {:else if pushState !== 'server-off'}
      <p>{t.server.checkPushNeedsNotify}</p>
      <NotificationSettings />
    {/if}
    <div aria-live="polite">
      {#if pushResult?.ok}
        <p>
          {pushResult.text}
          <a href={docsLink('faq', app.lang)} target="_blank" rel="noopener">{t.server.checkFaq}</a>
        </p>
      {:else if pushResult}
        {@render failure(pushResult.msg)}
      {:else if pushState === 'server-off'}
        {@render failure(describeCheckFailure({ status: 409, code: 'push_disabled', ms: 0 }, { context: 'app', settingsPath, lang: app.lang }))}
      {/if}
    </div>
    {#if last}
      <p class="muted small" data-testid="check-last">{t.server.checkLast(formatTime(last.at), t.server.checkLastResult(last.result))}</p>
    {/if}
  </div>
</div>

<style>
  .tight {
    gap: var(--sp-2);
  }
</style>
