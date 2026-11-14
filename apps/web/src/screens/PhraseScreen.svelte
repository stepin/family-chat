<script lang="ts">
  import Page from '../components/Page.svelte';
  import RecoveryPhrase from '../components/RecoveryPhrase.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';

  const account = $derived(app.account!);
</script>

<Page title={t.phrase.title} onback={() => nav.back()} narrow>
  <RecoveryPhrase userId={account.userId} ondone={() => nav.back()} />
</Page>
