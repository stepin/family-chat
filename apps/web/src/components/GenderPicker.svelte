<script lang="ts">
  import type { Gender } from '../lib/strings.ts';
  import { t } from '../lib/strings.ts';

  // The profile's gender, two options (М / Ж, M / F), male by default.
  // Used next to the name when joining and in "Мой профиль". The visible
  // letters carry the full word for screen readers.
  let {
    value = $bindable('m'),
    id,
    disabled = false,
    hint = true,
    onchange,
  }: {
    value?: Gender;
    /** Prefix of the element ids (several pickers can be on one page). */
    id: string;
    disabled?: boolean;
    hint?: boolean;
    onchange?: (value: Gender) => void;
  } = $props();

  const options = $derived([
    { value: 'm' as const, short: t.gender.male, full: t.gender.maleName },
    { value: 'f' as const, short: t.gender.female, full: t.gender.femaleName },
  ]);
</script>

<fieldset class="gender" aria-describedby={hint ? `${id}-hint` : undefined} data-testid="gender-picker">
  <legend class="label">{t.gender.label}</legend>
  <div class="options">
    {#each options as o (o.value)}
      <label class="option">
        <input
          type="radio"
          name="{id}-gender"
          value={o.value}
          checked={value === o.value}
          {disabled}
          onchange={() => {
            value = o.value;
            onchange?.(o.value);
          }}
        />
        <span aria-hidden="true">{o.short}</span>
        <span class="visually-hidden">{o.short}, {o.full}</span>
      </label>
    {/each}
  </div>
  {#if hint}<span id="{id}-hint" class="hint">{t.gender.hint}</span>{/if}
</fieldset>

<style>
  .gender {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    margin: 0;
    padding: 0;
    border: 0;
  }

  .label {
    padding: 0;
    font-weight: 600;
  }

  .options {
    display: inline-flex;
    gap: var(--sp-2);
  }

  .option {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: calc(var(--touch) + var(--sp-4));
    min-height: var(--touch);
    padding: 0 var(--sp-3);
    border: 1px solid var(--line);
    border-radius: var(--r-m);
    background: var(--surface);
    font-weight: 600;
    cursor: pointer;
  }

  .option input {
    position: absolute;
    inset: 0;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }

  .option:has(input:checked) {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--on-accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .option:has(input:focus-visible) {
    outline: 3px solid var(--focus);
    outline-offset: 2px;
  }

  .option:has(input:disabled) {
    opacity: 0.55;
    cursor: default;
  }

  .hint {
    color: var(--muted);
    font-size: var(--text-s);
  }
</style>
