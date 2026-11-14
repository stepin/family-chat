<script lang="ts">
  import { nav } from '../../lib/nav.svelte.ts';
  import Welcome from './Welcome.svelte';
  import PasteInvite from './PasteInvite.svelte';
  import InviteGate from './InviteGate.svelte';
  import JoinFamily from './JoinFamily.svelte';
  import AdminSetup from './AdminSetup.svelte';
  import Restore from './Restore.svelte';
  import RevokeByPhrase from './RevokeByPhrase.svelte';
</script>

<div class="onboarding">
  {#if nav.top.name === 'paste-invite'}
    <PasteInvite />
  {:else if nav.top.name === 'gateway'}
    <InviteGate />
  {:else if nav.top.name === 'join'}
    <JoinFamily />
  {:else if nav.top.name === 'admin'}
    <AdminSetup />
  {:else if nav.top.name === 'restore'}
    <Restore />
  {:else if nav.top.name === 'revoke-phrase'}
    <RevokeByPhrase />
  {:else}
    <Welcome />
  {/if}
</div>

<style>
  .onboarding {
    height: 100%;
    min-height: 0;
  }
</style>
