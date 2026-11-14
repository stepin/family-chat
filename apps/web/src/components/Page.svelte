<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import { t } from '../lib/strings.ts';

  let {
    title,
    onback,
    backLabel = t.common.back,
    actions,
    children,
    narrow = false,
  }: {
    title: string;
    onback?: (() => void) | undefined;
    backLabel?: string;
    actions?: Snippet;
    children: Snippet;
    /** Centred column for onboarding forms. */
    narrow?: boolean;
  } = $props();
  const uid = $props.id();
</script>

<section class="screen" aria-labelledby="{uid}-title">
  <header class="screen-header">
    {#if onback}
      <button class="icon-btn" type="button" aria-label={backLabel} onclick={onback}>
        <Icon name="back" />
      </button>
    {/if}
    <h1 id="{uid}-title" class:pad={!onback}>{title}</h1>
    {#if actions}{@render actions()}{/if}
  </header>
  <div class="screen-body">
    <div class="content" class:narrow>
      {@render children()}
    </div>
  </div>
</section>

<style>
  h1.pad {
    padding-left: var(--sp-2);
  }

  .narrow {
    max-width: 30rem;
  }
</style>
