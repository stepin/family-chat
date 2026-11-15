<script lang="ts" module>
  export type MessageAction = 'reply' | 'copy' | 'forward' | 'edit' | 'delete';
</script>

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { quickReactions } from '../lib/reactions.ts';
  import { t } from '../lib/strings.ts';

  // The one menu of a message (long press, right click, the "⋯" button or the
  // keyboard): a row of quick reactions with "more", then the actions. Proper
  // menu semantics: role="menu", arrow keys, Home/End, Escape closes, focus
  // goes back to where the menu was opened from. Bottom sheet on narrow
  // screens, a popover next to the message on wide ones.
  let {
    actions,
    reactions = true,
    mine = [],
    anchor = null,
    onaction,
    onreact,
    onmore,
    onclose,
  }: {
    actions: readonly MessageAction[];
    /** Show the reaction row. */
    reactions?: boolean;
    /** Emoji I already placed on this message (shown pressed). */
    mine?: readonly string[];
    /** Where the menu was opened (a popover is placed next to it on wide screens). */
    anchor?: DOMRect | null;
    onaction: (a: MessageAction) => void;
    onreact: (emoji: string) => void;
    onmore: () => void;
    onclose: () => void;
  } = $props();

  let dialog: HTMLDialogElement | undefined = $state();
  let menu: HTMLElement | undefined = $state();
  let returnTo: HTMLElement | null = null;
  let pos = $state<string | null>(null);
  let finished = false;

  const labels: Record<MessageAction, string> = {
    reply: t.msg.reply,
    copy: t.msg.copy,
    forward: t.msg.forward,
    edit: t.msg.edit,
    delete: t.msg.delete,
  };
  const icons: Record<MessageAction, 'reply' | 'copy' | 'share' | 'edit' | 'trash'> = {
    reply: 'reply',
    copy: 'copy',
    forward: 'share',
    edit: 'edit',
    delete: 'trash',
  };

  onMount(() => {
    returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const wide = typeof matchMedia === 'function' && matchMedia('(min-width: 600px)').matches;
    if (wide && anchor) {
      const w = 300;
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, anchor.left));
      const below = anchor.bottom + 8;
      const top = below + 320 > window.innerHeight ? Math.max(8, anchor.top - 328) : below;
      pos = `left:${Math.round(left)}px;top:${Math.round(top)}px;width:${w}px`;
    }
    dialog?.showModal();
    void tick().then(() => items()[0]?.focus());
    return () => returnTo?.focus();
  });

  function items(): HTMLElement[] {
    return [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]') ?? [])];
  }

  /**
   * Closes the menu; `after` (the chosen action) runs at once, in the same
   * turn as the click: the parent removes the menu (focus goes back to the
   * opener) before anything the action opens takes the focus.
   */
  function close(after?: () => void): void {
    if (finished) return;
    finished = true;
    onclose();
    after?.();
  }

  function onClose(): void {
    // Escape or a click on the backdrop.
    if (!finished) close();
  }

  function onKey(e: KeyboardEvent): void {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const inRow = (document.activeElement as HTMLElement | null)?.dataset['row'] === 'reactions';
    let next = -1;
    if (e.key === 'ArrowDown') {
      if (inRow) next = list.findIndex((x) => x.dataset['row'] !== 'reactions');
      else next = (i + 1) % list.length;
    } else if (e.key === 'ArrowUp') {
      if (inRow) next = list.length - 1;
      else {
        next = i - 1;
        if (next >= 0 && list[next]?.dataset['row'] === 'reactions') next = 0;
        if (next < 0) next = list.length - 1;
      }
    } else if (e.key === 'ArrowRight' && inRow) next = Math.min(i + 1, list.filter((x) => x.dataset['row'] === 'reactions').length - 1);
    else if (e.key === 'ArrowLeft' && inRow) next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'Tab') {
      // A menu is one tab stop: Tab closes it like Escape.
      e.preventDefault();
      close();
      return;
    } else return;
    e.preventDefault();
    list[next]?.focus();
  }

  function onBackdrop(e: MouseEvent): void {
    if (e.target === dialog) close();
  }

  function onCancel(e: Event): void {
    e.preventDefault();
    close();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialog} class="menu-dialog" class:popover={pos !== null} style={pos ?? undefined} onclose={onClose} oncancel={onCancel} onclick={onBackdrop} aria-label={t.msg.menu}>
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div bind:this={menu} class="menu" role="menu" aria-label={t.msg.menu} tabindex="-1" onkeydown={onKey} data-testid="message-menu">
    {#if reactions}
      <div class="reactions" role="group" aria-label={t.msg.reactions}>
        {#each quickReactions() as [emoji, name] (emoji)}
          <button
            class="reaction"
            class:on={mine.includes(emoji)}
            type="button"
            role="menuitemcheckbox"
            aria-checked={mine.includes(emoji)}
            aria-label={t.msg.react(name)}
            data-row="reactions"
            tabindex="-1"
            onclick={() => close(() => onreact(emoji))}>{emoji}</button
          >
        {/each}
        <button
          class="reaction more"
          type="button"
          role="menuitem"
          aria-label={t.msg.moreReactions}
          data-row="reactions"
          tabindex="-1"
          onclick={() => close(onmore)}><Icon name="plus" size={20} /></button
        >
      </div>
    {/if}
    {#each actions as a (a)}
      <button class="item" class:danger={a === 'delete'} type="button" role="menuitem" tabindex="-1" onclick={() => close(() => onaction(a))}>
        <span class="icon"><Icon name={icons[a]} size={20} /></span>
        {labels[a]}
      </button>
    {/each}
  </div>
</dialog>

<style>
  .menu-dialog {
    width: 100%;
    max-width: 32rem;
    margin: auto auto 0;
    padding: var(--sp-2) 0 max(var(--sp-2), env(safe-area-inset-bottom));
    border-radius: var(--r-l) var(--r-l) 0 0;
  }

  .menu-dialog.popover {
    position: fixed;
    margin: 0;
    max-width: none;
    padding: var(--sp-2) 0;
    border-radius: var(--r-l);
    box-shadow: var(--shadow);
  }

  .menu {
    display: flex;
    flex-direction: column;
  }

  .reactions {
    display: flex;
    justify-content: space-between;
    gap: 2px;
    padding: 0 var(--sp-2) var(--sp-2);
    border-bottom: 1px solid var(--line);
    margin-bottom: var(--sp-1);
  }

  .reaction {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--touch);
    height: var(--touch);
    border: 0;
    border-radius: 50%;
    background: transparent;
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
    color: var(--text);
  }

  .reaction:hover,
  .reaction:focus-visible {
    background: var(--surface-2);
  }

  .reaction.on {
    background: var(--accent-soft);
  }

  .item {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-height: var(--touch);
    padding: 0 var(--sp-4);
    border: 0;
    background: transparent;
    color: var(--text);
    font-size: var(--text-m);
    text-align: left;
    cursor: pointer;
  }

  .item:hover,
  .item:focus-visible {
    background: var(--surface-2);
  }

  .item.danger {
    color: var(--error);
  }

  .icon {
    display: inline-flex;
    color: var(--muted);
  }

  .danger .icon {
    color: inherit;
  }
</style>
