"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getPushConfig,
  listPushDevices,
  registerPushDevice,
  revokePushDevice,
  updatePushDevice,
} from "../../../lib/api";
import type { PushDevice } from "../../../lib/api";

/*
 * Réglages > Notifications (ticket 2.17). Opt-in par appareil (défaut OFF :
 * rien n'existe tant que l'utilisateur n'active pas), préférences par type,
 * révocation. iOS Safari : le push exige la PWA installée — le guide
 * « Ajouter à l'écran d'accueil » s'affiche AVANT toute demande de
 * permission, sinon l'activation échouerait en silence.
 */

type Permission = "default" | "granted" | "denied" | "unsupported";

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return "iPhone / iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "PC Windows";
  return "Navigateur";
}

/** iOS Safari hors PWA installée : l'API Push n'existe pas ou échoue muettement. */
function isIosSafariNotInstalled(): boolean {
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  return isIos && !standalone;
}

export default function NotificationsPage() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [vapidKey, setVapidKey] = useState<string | null>(null);
  const [permission, setPermission] = useState<Permission>("default");
  const [needsInstall, setNeedsInstall] = useState(false);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [thisDeviceId, setThisDeviceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [config, list] = await Promise.all([getPushConfig(), listPushDevices()]);
    setConfigured(config.configured);
    setVapidKey(config.vapidPublicKey);
    setDevices(list);
  }, []);

  useEffect(() => {
    setPermission(
      typeof Notification === "undefined" || !("serviceWorker" in navigator)
        ? "unsupported"
        : (Notification.permission as Permission),
    );
    setNeedsInstall(isIosSafariNotInstalled());
    refresh().catch(() => setError("réglages indisponibles — réessayez"));
  }, [refresh]);

  // Identifie l'appareil courant dans la liste (via la subscription locale).
  useEffect(() => {
    if (permission !== "granted" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .getRegistration("/sw.js")
      .then((registration) => registration?.pushManager.getSubscription())
      .then((subscription) => {
        if (subscription) setThisDeviceId("registered");
      })
      .catch(() => undefined);
  }, [permission, devices]);

  async function enable(): Promise<void> {
    setError(null);
    if (needsInstall) return; // le guide s'affiche déjà — pas de demande vouée à l'échec
    if (!vapidKey) {
      setError("notifications non configurées côté serveur");
      return;
    }
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result as Permission);
      if (result !== "granted") return;
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey).buffer as ArrayBuffer,
      });
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
        throw new Error("subscription incomplete");
      }
      await registerPushDevice({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        userAgent: deviceLabel(),
      });
      await refresh();
    } catch {
      setError("activation impossible — vérifiez la permission du navigateur");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(device: PushDevice, field: "actionsEnabled" | "alertsEnabled") {
    await updatePushDevice(device.id, { [field]: !device[field] }).catch(() => undefined);
    await refresh().catch(() => undefined);
  }

  async function revoke(device: PushDevice) {
    // Révoquer côté serveur suffit (plus d'envoi) ; on désabonne aussi le
    // navigateur si c'est l'appareil courant.
    await revokePushDevice(device.id).catch(() => undefined);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/sw.js");
      const subscription = await registration?.pushManager.getSubscription();
      await subscription?.unsubscribe();
    } catch {
      /* meilleure-effort */
    }
    await refresh().catch(() => undefined);
  }

  return (
    <div className="page">
      <section className="card">
        <h2>Notifications push</h2>
        <p className="muted">
          Une sonnette, pas un document : la notification indique seulement «&nbsp;N actions en
          attente&nbsp;» ou «&nbsp;alerte urgente&nbsp;» — jamais un nom, un montant ou un IBAN.
          Le détail s&apos;affiche dans l&apos;app, après connexion.
        </p>

        {configured === false && (
          <p className="warn">
            Notifications non configurées côté serveur (clés VAPID absentes) — contactez
            l&apos;administrateur.
          </p>
        )}
        {permission === "unsupported" && (
          <p className="warn">Ce navigateur ne prend pas en charge les notifications push.</p>
        )}
        {permission === "denied" && (
          <p className="warn">
            Permission refusée dans le navigateur : réautorisez les notifications pour ce site
            dans ses réglages, puis revenez ici.
          </p>
        )}

        {needsInstall ? (
          <div className="ios-guide">
            <h3>iPhone / iPad : installez d&apos;abord l&apos;app</h3>
            <p className="muted">
              Sur iOS, les notifications exigent que NODAQ soit installé sur l&apos;écran
              d&apos;accueil&nbsp;:
            </p>
            <ol>
              <li>
                Touchez le bouton <strong>Partager</strong> de Safari (carré avec flèche).
              </li>
              <li>
                Choisissez <strong>«&nbsp;Sur l&apos;écran d&apos;accueil&nbsp;»</strong>.
              </li>
              <li>Ouvrez NODAQ depuis l&apos;écran d&apos;accueil et revenez sur cette page.</li>
            </ol>
          </div>
        ) : (
          configured === true &&
          permission !== "unsupported" &&
          permission !== "denied" && (
            <button className="primary" onClick={() => void enable()} disabled={busy}>
              {busy
                ? "Activation…"
                : thisDeviceId
                  ? "Réactiver sur cet appareil"
                  : "Activer les notifications sur cet appareil"}
            </button>
          )
        )}
        {error && <p className="warn">{error}</p>}
      </section>

      <section className="card">
        <h3>Appareils enregistrés</h3>
        {devices.length === 0 ? (
          <p className="muted">Aucun appareil — les notifications sont désactivées (défaut).</p>
        ) : (
          <ul className="device-list">
            {devices.map((device) => (
              <li key={device.id} className="device-row">
                <div>
                  <strong>{device.userAgent ?? "Appareil"}</strong>
                  <span className="muted">
                    {" "}
                    — enregistré le {new Date(device.createdAt).toLocaleDateString("fr-FR")}
                  </span>
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={device.actionsEnabled}
                    onChange={() => void toggle(device, "actionsEnabled")}
                  />{" "}
                  Actions à valider
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={device.alertsEnabled}
                    onChange={() => void toggle(device, "alertsEnabled")}
                  />{" "}
                  Alertes urgentes
                </label>
                <button className="danger" onClick={() => void revoke(device)}>
                  Révoquer
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
