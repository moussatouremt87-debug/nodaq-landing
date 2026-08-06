import { emitDomainEvent, EVENT_VIEWS } from "./freshness";
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
 * Ouvre le flux et réinjecte les événements dans le bus local.
 *
 * Rend la fonction d'arrêt. `EventSource` reconnecte tout seul en cas de
 * coupure — c'est précisément pourquoi on ne construit rien de plus ici : un
 * mécanisme de reprise maison serait un second chemin à maintenir, et un
 * battement de cœur côté serveur suffit à garder la connexion ouverte à
 * travers les proxys.
 */
export function startLiveEvents(url = "/backend/events"): () => void {
  if (typeof EventSource === "undefined") return () => undefined;
  const source = new EventSource(url, { withCredentials: true });
  source.onmessage = (message: MessageEvent<string>) => {
    try {
      const delivery = JSON.parse(message.data) as LiveDelivery;
      if (isKnownEvent(delivery.type)) emitDomainEvent(delivery.type);
    } catch {
      /* une trame illisible ne doit pas couper l'écoute des suivantes */
    }
  };
  return () => source.close();
}
