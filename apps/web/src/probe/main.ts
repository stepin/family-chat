import { mount } from 'svelte';
import '../styles/base.css';
import Probe from './Probe.svelte';
import { collectEnvironment, prefillFromHash } from './environment.ts';
import { registerServiceWorker } from '../pwa.ts';

registerServiceWorker();

const prefill = prefillFromHash(location.hash);
mount(Probe, {
  target: document.getElementById('app')!,
  props: { environment: collectEnvironment, initialUrl: prefill.url, initialUser: prefill.user },
});
