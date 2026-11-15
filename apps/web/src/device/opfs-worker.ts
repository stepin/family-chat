/// <reference lib="webworker" />
// Writes and reads 1 MB through a sync access handle (the path iOS supports).
// It reports facts only; the page words them in its language (M7).
(async () => {
  try {
    const dir = await navigator.storage.getDirectory();
    const fh = await dir.getFileHandle('fc-device-check-worker.bin', { create: true });
    const handle = await (fh as FileSystemFileHandle & { createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> }).createSyncAccessHandle();
    const data = new Uint8Array(1024 * 1024).fill(7);
    handle.write(data, { at: 0 });
    handle.flush();
    const back = new Uint8Array(data.length);
    handle.read(back, { at: 0 });
    const size = handle.getSize();
    handle.close();
    await dir.removeEntry('fc-device-check-worker.bin');
    postMessage({ ok: size === data.length && back[back.length - 1] === 7, size });
  } catch (e) {
    postMessage({ ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
  }
})();
