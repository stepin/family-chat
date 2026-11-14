<script lang="ts">
  import Icon from './Icon.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { initial } from '../lib/names.ts';

  // A person's avatar (their signed profile picture, fetched and checked by
  // the core) or a placeholder: the first letter, the group sign, or the
  // bookmark of "Избранное". Decorative: the name is always next to it.
  let {
    accountId,
    userId = null,
    name = null,
    kind = 'person',
    hasAvatar = false,
    size = 44,
  }: {
    accountId: string;
    userId?: string | null;
    name?: string | null;
    kind?: 'person' | 'group' | 'self';
    /** The member's profile names an avatar (Member.avatar); only then the core is asked. */
    hasAvatar?: boolean;
    size?: number;
  } = $props();

  let url = $state<string | null>(null);

  $effect(() => {
    if (kind !== 'person' || !userId || !hasAvatar) {
      url = null;
      return;
    }
    let current: string | null = null;
    const unsub = app.core.avatar(accountId, userId).subscribe((a) => {
      if (current) URL.revokeObjectURL(current);
      current = a ? URL.createObjectURL(a.blob) : null;
      url = current;
    });
    return () => {
      unsub();
      if (current) URL.revokeObjectURL(current);
      current = null;
    };
  });
</script>

<span class="avatar" class:group={kind === 'group'} class:self={kind === 'self'} style:--size="{size}px" aria-hidden="true">
  {#if url}
    <img src={url} alt="" width={size} height={size} />
  {:else if kind === 'group'}
    <Icon name="users" size={Math.round(size * 0.5)} />
  {:else if kind === 'self'}
    <Icon name="bookmark" size={Math.round(size * 0.5)} />
  {:else}
    {initial(name)}
  {/if}
</span>

<style>
  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: var(--size);
    height: var(--size);
    border-radius: 50%;
    overflow: hidden;
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 700;
    font-size: calc(var(--size) * 0.4);
    line-height: 1;
  }

  .avatar.group,
  .avatar.self {
    background: var(--accent-soft);
    color: var(--on-accent-soft);
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
</style>
