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
    | 'close'
    | 'users'
    | 'bookmark'
    | 'clip'
    | 'camera'
    | 'image'
    | 'file'
    | 'download'
    | 'zoom-in'
    | 'zoom-out'
    | 'shield'
    | 'forward'
    | 'mic'
    | 'trash'
    | 'lock'
    | 'play'
    | 'pause'
    | 'pin';

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
    users:
      'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.4c2.1.7 3.5 2.8 3.5 5.6',
    bookmark: 'M6 3h12v18l-6-4.5L6 21z',
    clip: 'M20 11.5l-8.3 8.3a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4L15 7.1',
    camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    image: 'M4 5h16v14H4zM4 16l5-5 4 4 2.5-2.5L20 17M15.5 9.5h.01',
    file: 'M6 3h8l4 4v14H6zM14 3v4h4',
    download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
    'zoom-in': 'M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20.5 20.5l-5-5M10.5 7.5v6M7.5 10.5h6',
    'zoom-out': 'M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20.5 20.5l-5-5M7.5 10.5h6',
    shield: 'M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z',
    forward: 'M9 5l7 7-7 7',
    mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
    play: 'M8 5v14l11-7z',
    pause: 'M9 5v14M15 5v14',
    pin: 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
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
