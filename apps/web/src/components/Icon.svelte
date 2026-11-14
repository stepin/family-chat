<script lang="ts" module>
  export type IconName =
    | 'back'
    | 'settings'
    | 'plus'
    | 'send'
    | 'clock'
    | 'check'
    | 'alert'
    | 'copy'
    | 'chevron'
    | 'share'
    | 'close';

  // 24x24 outline paths (stroke = currentColor).
  const PATHS: Record<IconName, string> = {
    back: 'M15 5l-7 7 7 7',
    settings:
      'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4L10.6 6a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4z',
    plus: 'M12 5v14M5 12h14',
    send: 'M4 12l16-8-6 16-2.5-6.5L4 12z',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    alert: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5v5.5M12 16.5v.5',
    copy: 'M9 9h10v11H9zM5 15V4h10',
    chevron: 'M9 5l7 7-7 7',
    share: 'M12 15V3M7 8l5-5 5 5M5 13v7h14v-7',
    close: 'M6 6l12 12M18 6L6 18',
  };
</script>

<script lang="ts">
  let { name, size = 24 }: { name: IconName; size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <path d={PATHS[name]} />
</svg>
