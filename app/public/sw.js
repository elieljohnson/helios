// Helios service worker. One job: receive push events, show notifications,
// open the Rivian app deep-link on tap.
//
// Registered by /lib/push-client.ts after the user grants Notification
// permission. Lives at /sw.js (root scope) so it can intercept events
// site-wide.
//
// Push payload contract (set by lib/push.ts on the server):
//   { title: string, body: string, url?: string, tag?: string }
//
// `tag` collapses repeats — phones show one notification per tag, with
// the most recent wins. Helios passes the recommendation kind ("stop",
// "start") so a fresh stop replaces the previous stop on the lock
// screen.
//
// `url` defaults to "rivian://" — confirmed working as iOS deep-link.
// On non-iOS / desktop browsers it falls through to the Rivian web
// app, which is acceptable.

self.addEventListener("install", (event) => {
  // Take control on the very first activation; otherwise the user
  // would need to reload the PWA before the first push works.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    // Push payload was non-JSON (rare; defensive). Show a generic
    // notification rather than dropping the event silently.
    data = { title: "Helios", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Helios";
  const options = {
    body: data.body || "",
    tag: data.tag || "helios",
    // Tagged notifications normally suppress sound on replace; setting
    // renotify=true forces the buzz on every replace, which is what
    // we want for charging-state changes.
    renotify: true,
    data: { url: data.url || "rivian://" },
    icon: "/icon",
    badge: "/icon",
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "rivian://";

  event.waitUntil(
    (async () => {
      // Try to focus an existing app window first; if there isn't one,
      // open the deep-link.
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of allClients) {
        if ("focus" in client) {
          await client.focus();
          // After focusing the PWA, navigate it to the deep-link too —
          // tapping the notification should land the user in the
          // Rivian app, not the Helios dashboard.
          if ("navigate" in client) {
            try {
              await client.navigate(url);
            } catch {
              // Cross-origin navigation may throw; fall back to openWindow.
              await self.clients.openWindow(url);
            }
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
