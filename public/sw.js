// Minimal service worker — its presence (with a fetch handler) makes the app
// installable as a standalone PWA. It doesn't cache; requests pass through to
// the local server, which is what we want for a live local tool.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  /* pass-through: let the browser handle the request normally */
});
