/*
 * Service worker NODAQ (ticket 2.17) — réception des notifications push.
 * Le payload est minimal PAR CONSTRUCTION (type + compteur + deep-link,
 * validé côté serveur) : aucune donnée métier ne transite par les services
 * push des navigateurs. La donnée s'affiche dans l'app, après auth.
 */

const TITLES = {
  actions_en_attente: "NODAQ — actions à valider",
  alerte_urgente: "NODAQ — alerte urgente",
};

const BODIES = {
  actions_en_attente: (count) =>
    count === 1 ? "1 action attend votre validation" : `${count} actions attendent votre validation`,
  alerte_urgente: (count) =>
    count === 1 ? "1 alerte à traiter" : `${count} alertes à traiter`,
};

const ALLOWED_LINKS = new Set(["/validation", "/", "/connecteurs"]);

self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  if (!payload || !TITLES[payload.type]) return;
  const count = Number.isInteger(payload.count) && payload.count > 0 ? payload.count : 1;
  const deepLink = ALLOWED_LINKS.has(payload.deepLink) ? payload.deepLink : "/";
  event.waitUntil(
    self.registration.showNotification(TITLES[payload.type], {
      body: BODIES[payload.type](count),
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: payload.type, // une seule notification visible par type (anti-pile)
      data: { deepLink },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const deepLink =
    event.notification.data && ALLOWED_LINKS.has(event.notification.data.deepLink)
      ? event.notification.data.deepLink
      : "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client) client.navigate(deepLink);
          return;
        }
      }
      return clients.openWindow(deepLink);
    }),
  );
});
