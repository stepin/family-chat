// Waits until every dav-dev server answers. Used by `pnpm dav:up` and CI.
export const targets = {
  nocors: 'http://127.0.0.1:18080/family-chat/',
  dufs: 'http://127.0.0.1:18081/family-chat/',
  nginx: 'http://127.0.0.1:18082/family-chat/',
  caddy: 'http://127.0.0.1:18083/family-chat/',
};

export async function waitForServers(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  const auth = 'Basic ' + Buffer.from('fc:secret').toString('base64');
  for (const [name, url] of Object.entries(targets)) {
    for (;;) {
      try {
        const res = await fetch(url, { method: 'PROPFIND', headers: { Depth: '0', Authorization: auth } });
        if (res.status === 207) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`${name} (${url}) did not come up`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await waitForServers();
  console.log('dav-dev: all servers are up');
}
