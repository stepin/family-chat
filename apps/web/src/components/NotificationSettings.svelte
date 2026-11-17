<script lang="ts">
  import { app } from '../lib/app.svelte.ts';
  import type { AccountView } from '@family-chat/core';
  import { pageServerUrl } from '../lib/invite.ts';
  import {
    disableNotifications,
    enableNotifications,
    notifyEnv,
    notifyState,
    pushAccountOf,
    retryNotifications,
    sameKeyFamilies,
  } from '../lib/push.ts';
  import { t } from '../lib/strings.ts';

  // The real notification state on this device.
  // Several families: the browser holds one push subscription for one
  // server key. Turning them on here also turns them on for the other
  // families of the same server ("also on for"); turning them off is for
  // this family only. A family of another server can move them here.
  const account = $derived(app.account!);
  let env = $state(notifyEnv());
  let busy = $state(false);
  let error = $state<string | null>(null);
  const pushAccount = $derived(pushAccountOf(app.accounts, pageServerUrl(location)));
  const pushState = $derived(notifyState(env, app.platform, account, pushAccount));
  const several = $derived(app.accounts.filter((a) => a.status !== 'removed').length > 1);
  /** Other families of this server that get notifications too. */
  const alsoOn = $derived(sameKeyFamilies(app.accounts, account).filter((a) => a.pushRegistered));
  /** Families of other servers on this device (only then is the "one server" note true). */
  const otherServers = $derived(
    app.accounts.some((a) => a.status !== 'removed' && a.id !== account.id && a.vapidPublicKey !== account.vapidPublicKey),
  );
  let failed = $state.raw<AccountView[]>([]);

  async function enable(): Promise<void> {
    // The permission request is the first thing after the tap (inside enableNotifications).
    busy = true;
    error = null;
    try {
      failed = [...(await enableNotifications(app.core, account, app.accounts)).failed];
    } catch (e) {
      error = t.notify.failed;
      app.log('warn', 'push', 'enabling notifications failed', e);
    } finally {
      env = notifyEnv();
      busy = false;
    }
  }

  async function disable(): Promise<void> {
    busy = true;
    error = null;
    try {
      await disableNotifications(app.core, account, app.accounts);
    } catch (e) {
      error = t.errors.generic;
      app.log('warn', 'push', 'disabling notifications failed', e);
    } finally {
      env = notifyEnv();
      busy = false;
    }
  }

  async function retry(a: AccountView): Promise<void> {
    busy = true;
    try {
      await retryNotifications(app.core, a);
      failed = failed.filter((f) => f.id !== a.id);
    } catch (e) {
      app.log('warn', 'push', 'retrying notifications for a family failed', e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="stack" data-testid="notify-state" data-state={pushState}>
  {#if pushState === 'allowed'}
    <p><strong>{t.notify.allowed}.</strong> {t.notify.allowedText}</p>
    {#if alsoOn.length > 0}<p class="small" data-testid="push-also-for">{t.notify.alsoFor(alsoOn.map((a) => `«${a.familyName}»`).join(', '))}</p>{/if}
    {#if several && otherServers}<p class="muted small" data-testid="push-one-family">{t.notify.severalFamilies}</p>{/if}
    <button class="btn secondary" type="button" disabled={busy} onclick={disable}>{t.notify.disable}</button>
  {:else if pushState === 'other-family'}
    <p><strong>{t.notify.otherFamily(pushAccount?.familyName ?? '')}.</strong> {t.notify.otherFamilyText}</p>
    <button class="btn secondary" type="button" disabled={busy} onclick={enable}>{busy ? t.notify.enabling : t.notify.moveHere}</button>
  {:else if pushState === 'granted-unregistered' || pushState === 'off'}
    <p><strong>{pushState === 'off' ? t.notify.off : t.notify.notAllowed}.</strong> {t.notify.offText}</p>
    {#if several && otherServers}<p class="muted small" data-testid="push-one-family">{t.notify.severalFamilies}</p>{/if}
    <button class="btn" type="button" disabled={busy} onclick={enable}>{busy ? t.notify.enabling : t.notify.enable}</button>
  {:else if pushState === 'denied'}
    <p><strong>{t.notify.denied}.</strong> {t.notify.deniedText}</p>
  {:else if pushState === 'ios-install'}
    <p><strong>{t.notify.unavailable}.</strong> {t.notify.iosHint}</p>
  {:else if pushState === 'server-off'}
    <p><strong>{t.notify.unavailable}.</strong> {t.notify.serverOff}</p>
  {:else}
    <p><strong>{t.notify.unavailable}.</strong> {t.notify.unavailableText}</p>
  {/if}
  {#each failed as f (f.id)}
    <p class="error-text" role="alert" data-testid="push-failed-family">
      {t.notify.failedFor(f.familyName)}
      <button class="btn secondary small" type="button" disabled={busy} onclick={() => retry(f)}>{t.notify.retry}</button>
    </p>
  {/each}
  {#if error}<p class="error-text" role="alert">{error}</p>{/if}
</div>
