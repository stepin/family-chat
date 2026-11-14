<script lang="ts">
  import { app } from '../lib/app.svelte.ts';
  import { disableNotifications, enableNotifications, notifyEnv, notifyState, pushAccountOf } from '../lib/push.ts';
  import { t } from '../lib/strings.ts';

  // The real notification state on this device (docs/PLAN-v2.md 8, screen 20).
  // Several families (M5): the browser holds one push subscription, so one
  // family sends notifications; the screen says which and can move them here.
  const account = $derived(app.account!);
  let env = $state(notifyEnv());
  let busy = $state(false);
  let error = $state<string | null>(null);
  const pushAccount = $derived(pushAccountOf(app.accounts, location.origin));
  const pushState = $derived(notifyState(env, app.platform, account, pushAccount));
  const several = $derived(app.accounts.filter((a) => a.status !== 'removed').length > 1);

  async function enable(): Promise<void> {
    // The permission request is the first thing after the tap (inside enableNotifications).
    busy = true;
    error = null;
    try {
      await enableNotifications(app.core, account, app.accounts);
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
      await disableNotifications(app.core, account);
    } catch (e) {
      error = t.errors.generic;
      app.log('warn', 'push', 'disabling notifications failed', e);
    } finally {
      env = notifyEnv();
      busy = false;
    }
  }
</script>

<div class="stack" data-testid="notify-state" data-state={pushState}>
  {#if pushState === 'allowed'}
    <p><strong>{t.notify.allowed}.</strong> {t.notify.allowedText}</p>
    {#if several}<p class="muted small" data-testid="push-one-family">{t.notify.severalFamilies}</p>{/if}
    <button class="btn secondary" type="button" disabled={busy} onclick={disable}>{t.notify.disable}</button>
  {:else if pushState === 'other-family'}
    <p><strong>{t.notify.otherFamily(pushAccount?.familyName ?? '')}.</strong> {t.notify.otherFamilyText}</p>
    <button class="btn secondary" type="button" disabled={busy} onclick={enable}>{busy ? t.notify.enabling : t.notify.moveHere}</button>
  {:else if pushState === 'granted-unregistered' || pushState === 'off'}
    <p><strong>{pushState === 'off' ? t.notify.off : t.notify.notAllowed}.</strong> {t.notify.offText}</p>
    {#if several}<p class="muted small" data-testid="push-one-family">{t.notify.severalFamilies}</p>{/if}
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
  {#if error}<p class="error-text" role="alert">{error}</p>{/if}
</div>
