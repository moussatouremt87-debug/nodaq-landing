import { emitDomainEvent, EVENT_VIEWS, refreshAllViews } from "./freshness";
import type { DomainEvent } from "./freshness";

/*
 * Écoute du bus serveur (4.4, PR A) — le dernier maillon.
 *
 * CE QUE ÇA FERME. Chaque écran se rafraîchit déjà après SA propre mutation.
 * Ce qui manquait, c'est l'écriture venue d'AILLEURS : l'agent dans le chat,
 * un autre onglet, un webhook, un collègue. Le patron voyait alors des
 * chiffres d'il y a dix minutes sans que rien ne le dise — « un cockpit qui
 * ment est pire qu'un cockpit vide ».
 *
 * LE FLUX NE PORTE QUE DES TYPES. On reçoit « quelque chose de cette nature a
 * changé », et on le réinjecte dans le bus local, qui sait quelles vues
 * périmer : les écrans relisent par leurs routes habituelles, donc sous la
 * chaîne d'autorisation. Un flux qui transporterait les valeurs ferait fuir
 * sur un canal ouvert en permanence, bien plus difficile à auditer qu'une
 * requête.
 */

/** Événement livré par le relais — de quoi RELIRE, jamais de quoi lire. */
interface LiveDelivery {
  readonly type: string;
}

/**
 * Un type INCONNU est ignoré, pas propagé.
 *
 * Le serveur peut être en avance sur le navigateur pendant un déploiement
 * progressif. Réinjecter un type que le registre local ne connaît pas ne
 * périmerait rien mais lèverait dans `viewsFor` — et une exception dans un
 * gestionnaire de flux tue l'écoute pour tous les événements SUIVANTS,
 * y compris ceux qu'on sait traiter. Le silence est ici la bonne réponse :
 * l'écran se rafraîchira au prochain événement connu, ou au retour de focus.
 */
const KNOWN: ReadonlySet<string> = new Set(Object.keys(EVENT_VIEWS));

function isKnownEvent(type: string): type is DomainEvent {
  // Dérivé du registre, jamais recopié : une liste écrite à la main ici
  // divergerait au premier ajout d'événement, et les nouveaux seraient
  // silencieusement ignorés — la panne de fraîcheur, déplacée d'un cran.
  return KNOWN.has(type);
}

/**
 * Délai avant de retenter APRÈS un abandon définitif d'`EventSource`.
 *
 * `EventSource` reprend tout seul sur une coupure réseau, mais PAS sur un
 * statut != 200 : il passe en `CLOSED` et ne rouvre jamais. Un cinquième
 * onglet refusé par le plafond de flux (429) restait donc muet pour toute la
 * vie de la page, alors que le refus est transitoire par nature — il suffit
 * qu'un autre onglet se ferme.
 */
const REOPEN_MS = 30_000;

/** `EventSource.CLOSED` — la constante n'existe pas sur toutes les cibles. */
const CLOSED = 2;

/**
 * Ouvre le flux et réinjecte les événements dans le bus local.
 *
 * Rend la fonction d'arrêt.
 *
 * TOUTE (RÉ)OUVERTURE RECHARGE TOUT. C'est le point non négociable : le relais
 * serveur marque un événement transmis même sans abonné branché, et ne le
 * représente jamais. Chaque intervalle sans flux — reconnexion programmée
 * toutes les 30 min, redéploiement, tunnel, 429 — est donc une fenêtre
 * d'invalidations PERDUES. Ne rien faire à l'ouverture laissait un écran
 * ouvert afficher des chiffres faux pour toujours. On ne sait pas ce qui a été
 * manqué : on recharge tout, y compris à la première ouverture, qui suit le
 * chargement des écrans et porte donc la même fenêtre.
 */
export function startLiveEvents(url = "/backend/events", reopenMs = REOPEN_MS): () => void {
  if (typeof EventSource === "undefined") return () => undefined;
  let stopped = false;
  let source: EventSource | null = null;
  let reopen: ReturnType<typeof setTimeout> | null = null;

  const open = (): void => {
    if (stopped) return;
    const current = new EventSource(url, { withCredentials: true });
    source = current;
    current.onopen = () => {
      refreshAllViews();
    };
    current.onmessage = (message: MessageEvent<string>) => {
      try {
        const delivery = JSON.parse(message.data) as LiveDelivery;
        if (isKnownEvent(delivery.type)) emitDomainEvent(delivery.type);
      } catch {
        /* une trame illisible ne doit pas couper l'écoute des suivantes */
      }
    };
    current.onerror = () => {
      // `CLOSED` = abandon définitif. Sur les autres états, `EventSource`
      // reprend seul : le doubler d'une reprise maison ouvrirait deux flux.
      if (current.readyState !== CLOSED) return;
      current.close();
      if (stopped || reopen !== null) return;
      reopen = setTimeout(() => {
        reopen = null;
        open();
      }, reopenMs);
    };
  };

  open();
  return () => {
    stopped = true;
    if (reopen !== null) clearTimeout(reopen);
    source?.close();
  };
}
