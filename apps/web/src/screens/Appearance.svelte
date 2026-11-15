<script lang="ts">
  import Page from '../components/Page.svelte';
  import { app } from '../lib/app.svelte.ts';
  import {
    applyAppearance,
    BACKGROUNDS,
    DEFAULT_APPEARANCE,
    isDefaultAppearance,
    PALETTES,
    RADII,
    readAppearance,
    TEXT_SCALES,
    THEME_COLORS,
    THEMES,
    writeAppearance,
    type Appearance,
  } from '../lib/appearance.ts';
  import { nav } from '../lib/nav.svelte.ts';
  import { t } from '../lib/strings.ts';

  // Appearance (M7, Settings → "Оформление"), a subset of what Telegram
  // offers that suits a family chat: theme (system, light, dark), a colour
  // palette, text size in chats, message corners and a chat background.
  // Every change applies at once and is kept on this device only (see
  // lib/appearance.ts); the preview at the top is drawn with the same tokens.
  let a = $state<Appearance>(readAppearance());

  function set(change: Partial<Appearance>): void {
    a = { ...a, ...change };
    writeAppearance(a);
    applyAppearance(a);
  }

  function reset(): void {
    set(DEFAULT_APPEARANCE);
    app.notify(t.appearance.resetDone);
  }
</script>

<Page title={t.appearance.title} onback={() => nav.back()}>
  <section class="section" aria-labelledby="look-preview">
    <h2 id="look-preview">{t.appearance.preview}</h2>
    <div class="preview chat-scaled" data-testid="appearance-preview">
      <div class="feed chat-bg">
        <div class="msg">
          <div class="bubble">
            <span class="author">{t.appearance.previewName}</span>
            <p class="text">{t.appearance.previewIncoming}</p>
            <span class="meta tabular">18:02</span>
          </div>
        </div>
        <div class="msg out">
          <div class="bubble">
            <p class="text">{t.appearance.previewOutgoing}</p>
            <span class="meta tabular">18:03</span>
          </div>
        </div>
        <div class="msg">
          <div class="bubble">
            <span class="author">{t.appearance.previewName}</span>
            <p class="text">{t.appearance.previewReply}</p>
            <span class="meta tabular">18:04</span>
          </div>
        </div>
      </div>
      <div class="bar" aria-hidden="true">
        <span class="field">{t.chat.composerPlaceholder}</span>
        <span class="badge tabular">3</span>
      </div>
    </div>
    <p class="muted small">{t.appearance.note}</p>
  </section>

  <section class="section" aria-labelledby="look-theme">
    <h2 id="look-theme">{t.appearance.theme}</h2>
    <div class="segments" role="radiogroup" aria-labelledby="look-theme" data-testid="theme-choice">
      {#each THEMES as v (v)}
        <label class="segment">
          <input type="radio" name="look-theme" value={v} checked={a.theme === v} onchange={() => set({ theme: v })} />
          <span>{t.appearance.themes[v]}</span>
        </label>
      {/each}
    </div>
  </section>

  <section class="section" aria-labelledby="look-palette">
    <h2 id="look-palette">{t.appearance.palette}</h2>
    <div class="swatches" role="radiogroup" aria-labelledby="look-palette" data-testid="palette-choice">
      {#each PALETTES as v (v)}
        <label class="swatch">
          <input type="radio" name="look-palette" value={v} checked={a.palette === v} onchange={() => set({ palette: v })} />
          <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
            <circle cx="20" cy="20" r="18" fill={THEME_COLORS[v].light} />
            {#if a.palette === v}<path d="M13 20.5l4.5 4.5L27 15.5" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />{/if}
          </svg>
          <span class="swatch-name">{t.appearance.palettes[v]}</span>
        </label>
      {/each}
    </div>
  </section>

  <section class="section" aria-labelledby="look-size">
    <h2 id="look-size">{t.appearance.textSize}</h2>
    <div class="slider">
      <span class="a-small" aria-hidden="true">A</span>
      <input
        id="look-size-range"
        type="range"
        min="0"
        max={TEXT_SCALES.length - 1}
        step="1"
        value={a.textSize}
        aria-label={t.appearance.textSize}
        aria-valuetext={t.appearance.textSizes[a.textSize]}
        aria-describedby="look-size-hint"
        oninput={(e) => set({ textSize: Number((e.currentTarget as HTMLInputElement).value) })}
        data-testid="text-size"
      />
      <span class="a-large" aria-hidden="true">A</span>
    </div>
    <p class="small"><strong>{t.appearance.textSizes[a.textSize]}</strong></p>
    <p id="look-size-hint" class="muted small">{t.appearance.textSizeHint}</p>
  </section>

  <section class="section" aria-labelledby="look-radius">
    <h2 id="look-radius">{t.appearance.radius}</h2>
    <div class="segments" role="radiogroup" aria-labelledby="look-radius" data-testid="radius-choice">
      {#each RADII as v (v)}
        <label class="segment">
          <input type="radio" name="look-radius" value={v} checked={a.radius === v} onchange={() => set({ radius: v })} />
          <span>{t.appearance.radii[v]}</span>
        </label>
      {/each}
    </div>
  </section>

  <section class="section" aria-labelledby="look-bg">
    <h2 id="look-bg">{t.appearance.background}</h2>
    <div class="tiles" role="radiogroup" aria-labelledby="look-bg" data-testid="background-choice">
      {#each BACKGROUNDS as v (v)}
        <label class="tile">
          <input type="radio" name="look-bg" value={v} checked={a.background === v} onchange={() => set({ background: v })} />
          <span class="sample chat-bg-sample" data-bg={v} aria-hidden="true"></span>
          <span class="tile-name">{t.appearance.backgrounds[v]}</span>
        </label>
      {/each}
    </div>
  </section>

  <section class="section">
    <button class="btn secondary" type="button" disabled={isDefaultAppearance(a)} onclick={reset} data-testid="appearance-reset">{t.appearance.reset}</button>
  </section>
</Page>

<style>
  .preview {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--r-l);
  }

  .feed {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding: var(--sp-3);
  }

  .msg {
    display: flex;
  }

  .msg.out {
    justify-content: flex-end;
  }

  .bubble {
    display: flex;
    flex-direction: column;
    max-width: 80%;
    padding: var(--sp-2) var(--sp-3);
    border-radius: var(--bubble-radius);
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .out .bubble {
    background: var(--accent-soft);
    color: var(--on-accent-soft);
  }

  .author {
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--accent);
  }

  .text {
    font-size: var(--text-m);
    overflow-wrap: anywhere;
  }

  .meta {
    align-self: flex-end;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .out .meta {
    color: var(--on-accent-soft-muted);
  }

  .bar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    border-top: 1px solid var(--line);
    background: var(--surface);
  }

  .field {
    flex: 1 1 auto;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--line);
    border-radius: 22px;
    background: var(--bg);
    color: var(--muted);
    font-size: var(--text-m);
  }

  .badge {
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    border-radius: 11px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: var(--text-xs);
    font-weight: 700;
    line-height: 22px;
    text-align: center;
  }

  .segments {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }

  .segment,
  .swatch,
  .tile {
    position: relative;
    cursor: pointer;
  }

  .segment input,
  .swatch input,
  .tile input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }

  .segment span {
    display: inline-flex;
    align-items: center;
    min-height: var(--touch);
    padding: 0 var(--sp-4);
    border: 1px solid var(--line);
    border-radius: var(--r-m);
    background: var(--surface);
    font-weight: 600;
  }

  .segment input:checked + span {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--on-accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .segment:has(input:focus-visible),
  .swatch:has(input:focus-visible),
  .tile:has(input:focus-visible) {
    outline: 3px solid var(--focus);
    outline-offset: 2px;
    border-radius: var(--r-m);
  }

  .swatches {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(5.5rem, 1fr));
    gap: var(--sp-2);
  }

  .swatch {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-1);
    padding: var(--sp-2) var(--sp-1);
    border-radius: var(--r-m);
    text-align: center;
  }

  .swatch:has(input:checked) {
    background: var(--surface-2);
  }

  .swatch-name,
  .tile-name {
    font-size: var(--text-s);
  }

  .slider {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
  }

  .slider input {
    flex: 1 1 auto;
    min-height: var(--touch);
    accent-color: var(--accent);
  }

  .a-small {
    font-size: 0.875rem;
  }

  .a-large {
    font-size: 1.5rem;
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(5.5rem, 1fr));
    gap: var(--sp-2);
  }

  .tile {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    align-items: stretch;
    text-align: center;
  }

  .sample {
    display: block;
    height: 3.5rem;
    border: 1px solid var(--line);
    border-radius: var(--r-m);
  }

  .tile:has(input:checked) .sample {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 2px var(--accent);
  }

  .tile:has(input:checked) .tile-name {
    font-weight: 700;
  }
</style>
