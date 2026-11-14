<script lang="ts">
  import InviteFamily from '../components/InviteFamily.svelte';
  import Page from '../components/Page.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';

  const account = $derived(app.account!);
</script>

<Page title={t.invites.title} onback={() => nav.back()}>
  <section class="section" aria-label={t.invites.title}>
    <p>{t.admin.inviteLead}</p>
    {#if account.admin}
      <InviteFamily accountId={account.id} />
    {/if}
  </section>
</Page>
