<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../lib/strings.ts';

  // Small dialogs of the message menu (loaded on first use): "Удалить у
  // меня / у всех" with the honest wording of docs/PLAN.md 8.5, and the list
  // of who placed a reaction.
  type Props =
    | { kind: 'delete'; forAll: boolean; onconfirm: (forAll: boolean) => void; onclose: () => void; emoji?: never; names?: never }
    | { kind: 'who'; emoji: string; names: readonly string[]; onclose: () => void; forAll?: never; onconfirm?: never };
  let props: Props = $props();

  let dialog: HTMLDialogElement | undefined = $state();
  let returnTo: HTMLElement | null = null;
  let choice: boolean | null = null;

  onMount(() => {
    returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => returnTo?.focus();
  });

  function confirm(forAll: boolean): void {
    choice = forAll;
    dialog?.close();
  }

  function onClose(): void {
    const c = choice;
    choice = null;
    // The choice first, while the caller still knows which message this is.
    if (c !== null && props.kind === 'delete') props.onconfirm(c);
    props.onclose();
  }
</script>

<dialog bind:this={dialog} onclose={onClose} aria-labelledby="msg-dialog-title" data-testid={props.kind === 'delete' ? 'delete-dialog' : 'who-dialog'}>
  {#if props.kind === 'delete'}
    <div class="stack">
      <h2 id="msg-dialog-title">{t.msg.deleteTitle}</h2>
      <p>{props.forAll ? t.msg.deleteForAllText : t.msg.deleteForMeText}</p>
      <div class="stack">
        {#if props.forAll}
          <button class="btn danger" type="button" onclick={() => confirm(true)}>{t.msg.deleteForAll}</button>
        {/if}
        <button class="btn" class:secondary={props.forAll} class:danger={!props.forAll} type="button" onclick={() => confirm(false)}>{t.msg.deleteForMe}</button>
        <button class="btn secondary" type="button" onclick={() => dialog?.close()}>{t.common.cancel}</button>
      </div>
    </div>
  {:else}
    <div class="stack">
      <h2 id="msg-dialog-title">{t.msg.whoReacted(props.emoji)}</h2>
      <ul class="names">
        {#each props.names as n, i (i)}<li>{n}</li>{/each}
      </ul>
      <div class="row end"><button class="btn secondary" type="button" onclick={() => dialog?.close()}>{t.common.close}</button></div>
    </div>
  {/if}
</dialog>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }

  h2 {
    font-size: var(--text-l);
  }

  .names {
    margin: 0;
    padding-left: var(--sp-5);
  }

  .names li + li {
    margin-top: var(--sp-1);
  }

  .row.end {
    display: flex;
    justify-content: flex-end;
  }
</style>
