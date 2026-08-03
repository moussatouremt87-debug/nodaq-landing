"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createLoadGuard,
  formatFreshness,
  isStale,
  subscribeView,
  watchFreshness,
  type ViewKey,
} from "./freshness";

/*
 * Branchement React de la fraîcheur (ticket 2.21 A).
 *
 * Un écran déclare les VUES qu'il affiche et donne son chargeur. Il se
 * rafraîchit alors tout seul quand : (a) un événement de domaine périme l'une
 * de ces vues — y compris déclenché depuis un AUTRE écran ou par l'agent dans
 * le chat ; (b) l'onglet reprend le focus ; (c) le réseau revient.
 *
 * Il n'a jamais à « penser » à se rafraîchir : c'est la correspondance
 * `EVENT_VIEWS` qui décide, pas chaque page.
 */

export interface Freshness {
  /** Relance le chargeur à la main (bouton, action locale). */
  refresh: () => void;
  /** Horodatage du dernier chargement RÉUSSI, `null` si aucun. */
  updatedAt: number | null;
  /** Libellé prêt à afficher — « à jour il y a 3 min », « jamais rafraîchi ». */
  label: string;
  /** Vrai au-delà du seuil : l'écran doit le DIRE plutôt que se taire. */
  stale: boolean;
}

/** Au-delà, une donnée n'est plus présentée comme fraîche sans réserve. */
export const STALE_AFTER_MS = 5 * 60_000;

/**
 * @param views  vues affichées par l'écran (celles qui le périment)
 * @param load   chargeur — DOIT rendre une promesse ; l'horodatage n'avance
 *               qu'en cas de succès (afficher « à jour à l'instant » sur un
 *               échec de refetch serait exactement le mensonge qu'on corrige).
 *               Il n'a PAS besoin d'être mémoïsé : le hook garde la dernière
 *               version dans une ref. Le faire dépendre de `load` transformait
 *               un chargeur non mémoïsé en boucle de refetch infinie — un
 *               piège qu'il vaut mieux supprimer que documenter.
 */
export function useFreshness(views: readonly ViewKey[], load: () => Promise<unknown>): Freshness {
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  // Re-rendu périodique : sans lui, « il y a 3 min » resterait figé à
  // « à l'instant » tant que l'écran ne bouge pas.
  const [, setTick] = useState(0);

  // Les vues sont un tableau littéral côté appelant : on le fige en clé stable
  // pour ne pas réabonner à chaque rendu.
  const viewsKey = views.join(",");

  // Une garde par écran, créée une seule fois : le bus, le retour de focus et
  // le bouton peuvent lancer trois chargements simultanés, et seule la réponse
  // du DERNIER a le droit d'horodater. Sans elle, une réponse lente arrivée
  // après une rapide réafficherait des chiffres plus anciens en les annonçant
  // « à jour à l'instant » — le cockpit qui ment, reconstitué ici même.
  const guard = useMemo(() => createLoadGuard(), []);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  const refresh = useCallback(() => {
    void guard.run(() => loadRef.current()).then((outcome) => {
      if (outcome === "a-jour") setUpdatedAt(Date.now());
    });
  }, [guard]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const unsubscribes = viewsKey
      .split(",")
      .filter(Boolean)
      .map((view) => subscribeView(view as ViewKey, refresh));
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [viewsKey, refresh]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Deux cibles, UN abonnement chacune : `visibilitychange` n'existe que sur
    // `document`, `online` que sur `window`. Écouter les deux événements sur
    // les deux cibles doublait chaque réveil (visibilitychange remonte jusqu'à
    // `window`), soit deux chargements complets à chaque alt-tab.
    return watchFreshness(document, refresh, undefined, window);
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const now = Date.now();
  return {
    refresh,
    updatedAt,
    label: formatFreshness(updatedAt, now),
    stale: isStale(updatedAt, now, STALE_AFTER_MS),
  };
}

/**
 * Abonnement seul, pour les écrans secondaires.
 *
 * `useFreshness` impose un chargeur qui rend une promesse, pour pouvoir dire
 * l'âge de la donnée. Un écran de saisie n'affiche pas cet âge mais doit quand
 * même suivre les écritures des autres : sans ça, une vue déclarée dans la
 * config n'a AUCUN abonné, et l'événement qui la périme ne réveille personne —
 * une correspondance qui rassure sans rien garantir.
 *
 * `refresh` n'a pas besoin d'être mémoïsé (même ref que ci-dessus).
 */
export function useViewRefresh(views: readonly ViewKey[], refresh: () => void): void {
  const viewsKey = views.join(",");
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });

  useEffect(() => {
    const wake = (): void => refreshRef.current();
    const unsubscribes = viewsKey
      .split(",")
      .filter(Boolean)
      .map((view) => subscribeView(view as ViewKey, wake));
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [viewsKey]);
}
