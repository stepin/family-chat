<script lang="ts">
  import {
    CHECKS,
    VERDICT_TEXT,
    formatReport,
    runProbe,
    type CheckId,
    type CheckResult,
    type CheckStatus,
    type ProbeEnvironment,
    type ProbeReport,
  } from './probe.ts';

  interface Props {
    environment: () => Promise<ProbeEnvironment>;
    initialUrl?: string;
    initialUser?: string;
  }
  let { environment, initialUrl = '', initialUser = '' }: Props = $props();

  // svelte-ignore state_referenced_locally
  let url = $state(initialUrl);
  // svelte-ignore state_referenced_locally
  let username = $state(initialUser);
  let password = $state('');
  let runningId = $state<CheckId | null>(null);
  let busy = $state(false);
  let progress = $state<CheckResult[]>([]);
  let report = $state<ProbeReport | null>(null);
  let reportText = $state('');
  let copied = $state<'' | 'ok' | 'manual'>('');

  const LABEL: Record<CheckStatus, string> = {
    ok: 'Пройдена',
    warn: 'Предупреждение',
    fail: 'Не пройдена',
    info: 'Сведения',
    skip: 'Пропущена',
  };
  const MARK: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✕', info: 'i', skip: '–' };

  async function start(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    busy = true;
    report = null;
    reportText = '';
    copied = '';
    progress = [];
    try {
      const env = await environment();
      const result = await runProbe({
        url,
        username,
        password,
        environment: env,
        onProgress: (checks, id) => {
          progress = checks;
          runningId = id;
        },
      });
      report = result;
      reportText = formatReport(result, password);
    } finally {
      busy = false;
      runningId = null;
    }
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(reportText);
      copied = 'ok';
    } catch {
      copied = 'manual';
    }
  }

  function download(): void {
    const blob = new Blob([reportText], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `family-chat-probe-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  const failed = $derived(report ? report.checks.filter((c) => c.status === 'fail').length : 0);
  const warned = $derived(report ? report.checks.filter((c) => c.status === 'warn').length : 0);
</script>

<main>
  <h1>Проверка сервера WebDAV</h1>
  <p class="muted">
    Зонд проверяет, сможет ли Family Chat работать с вашей папкой WebDAV с этого адреса. Он создаст временную папку
    <code>fc-probe-…</code> в папке чата и удалит её. Пароль никуда не сохраняется и уходит только на ваш сервер.
  </p>

  <form class="card" onsubmit={start}>
    <label>
      <span>Адрес папки</span>
      <input
        name="url"
        type="url"
        inputmode="url"
        autocomplete="url"
        placeholder="https://home.example.net/webdav/family-chat/"
        required
        bind:value={url}
        data-testid="probe-url"
      />
    </label>
    <label>
      <span>Логин</span>
      <input name="username" autocomplete="username" autocapitalize="none" required bind:value={username} data-testid="probe-user" />
    </label>
    <label>
      <span>Пароль</span>
      <input name="password" type="password" autocomplete="current-password" required bind:value={password} data-testid="probe-password" />
    </label>
    <p class="muted small">
      Chrome может спросить разрешение на доступ к устройствам в локальной сети: оно нужно, если адрес сервера дома
      ведёт на роутер напрямую. Разрешите его.
    </p>
    <button type="submit" disabled={busy} data-testid="probe-run">{busy ? 'Проверяю…' : 'Проверить сервер'}</button>
  </form>

  {#if busy}
    <section class="card" aria-live="polite">
      <p>Выполнено проверок: {progress.length}{runningId ? `; сейчас: ${CHECKS[runningId]}` : ''}</p>
    </section>
  {/if}

  {#if report}
    <section class="card verdict {report.verdict}" aria-live="polite">
      <p class="verdict-line" data-testid="probe-verdict" data-verdict={report.verdict}>{VERDICT_TEXT[report.verdict]}</p>
      <p data-testid="probe-summary">{report.summary}</p>
      <p class="muted">{report.nextAction}</p>
      {#if report.nextActionUrl}
        <p><a href={report.nextActionUrl} target="_blank" rel="noopener noreferrer" data-testid="probe-instructions">Открыть инструкцию</a></p>
      {/if}
    </section>

    <details class="card">
      <summary data-testid="probe-checks-summary">
        Проверки: {report.checks.length}{failed ? `, не пройдено ${failed}` : ''}{warned ? `, предупреждений ${warned}` : ''}
      </summary>
      <ul class="checks">
        {#each report.checks as c, i (i)}
          <li class={c.status} data-testid="probe-check" data-check={c.id} data-status={c.status}>
            <span class="mark" aria-label={LABEL[c.status]}>{MARK[c.status]}</span>
            <span><strong>{c.title}.</strong> {c.detail}</span>
          </li>
        {/each}
      </ul>
    </details>

    <section class="actions">
      <button type="button" onclick={copy} data-testid="probe-copy">Скопировать отчёт</button>
      <button type="button" class="secondary" onclick={download}>Скачать отчёт</button>
      {#if copied === 'ok'}<span role="status">Отчёт скопирован. Пароля в нём нет.</span>{/if}
      {#if copied === 'manual'}<span role="status">Не удалось скопировать: выделите текст отчёта ниже.</span>{/if}
    </section>
    <details class="card" open={copied === 'manual'}>
      <summary>Текст отчёта</summary>
      <textarea readonly rows="12" data-testid="probe-report">{reportText}</textarea>
    </details>
  {/if}
</main>

<style>
  label {
    display: block;
    margin-bottom: var(--space);
  }
  label span {
    display: block;
    font-weight: 600;
    margin-bottom: 0.25rem;
  }
  input {
    width: 100%;
    padding: 0.6rem 0.7rem;
    min-height: 44px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--text);
  }
  .small {
    font-size: 0.9rem;
  }
  .verdict-line {
    font-size: 1.35rem;
    font-weight: 700;
    margin-bottom: 0.5rem;
  }
  .verdict.suitable .verdict-line {
    color: var(--ok);
  }
  .verdict.needs-setup .verdict-line {
    color: var(--warn);
  }
  .verdict.unsuitable .verdict-line {
    color: var(--fail);
  }
  summary {
    cursor: pointer;
    font-weight: 600;
  }
  .checks {
    list-style: none;
    padding: 0;
    margin: var(--space) 0 0;
  }
  .checks li {
    display: flex;
    gap: 0.6rem;
    padding: 0.5rem 0;
    border-top: 1px solid var(--line);
    overflow-wrap: anywhere;
  }
  .mark {
    flex: 0 0 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    border: 1px solid currentColor;
  }
  li.ok .mark {
    color: var(--ok);
  }
  li.warn .mark {
    color: var(--warn);
  }
  li.fail .mark {
    color: var(--fail);
  }
  li.info .mark,
  li.skip .mark {
    color: var(--muted);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    margin-bottom: var(--space);
  }
  textarea {
    width: 100%;
    margin-top: var(--space);
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.8rem;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }
</style>
