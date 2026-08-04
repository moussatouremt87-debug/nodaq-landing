"use client";

import { useCallback, useEffect, useState } from "react";
import { verticalLabel } from "@nodaq/shared";
import { ApiError, getModules, setModule } from "../../../lib/api";
import { emitDomainEvent } from "../../../lib/freshness";
import type { ModuleStates } from "../../../lib/api";

/*
 * Modules par vertical (3.11). L'état effectif vient du catalogue versionné
 * (défauts du vertical du profil 3.7) surchargé par les choix explicites du
 * dirigeant — chaque état affiche sa source. Désactiver un module retire sa
 * page de la navigation ET ses outils de l'employé virtuel ; les données ne
 * sont PAS supprimées et les autorisations API restent inchangées.
 */

export default function ModulesPage() {
  const [state, setState] = useState<ModuleStates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await getModules());
    } catch {
      setError("modules indisponibles — réessayez");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggle(id: string, active: boolean): Promise<void> {
    setError(null);
    setBusy(id);
    try {
      await setModule(id, active);
      await refresh();
      // La nav et le cockpit changent de forme : ils doivent suivre sans que
      // l'utilisateur ait à recharger la page (pivot ADR-007).
      emitDomainEvent("module.bascule");
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? "réglage réservé au dirigeant"
          : "modification impossible",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page">
      <section className="card">
        <h2>Modules activés</h2>
        {state === null ? (
          <p className="muted">{error ?? "Chargement…"}</p>
        ) : (
          <>
            <p className="muted">
              {state.vertical
                ? // Le LIBELLÉ du pack, pas l'identifiant brut : « services_projet »
                  // ou « evenementiel » affiché à un dirigeant se lit comme une
                  // fuite de code. Les anciens ids (« retail », « services »)
                  // passaient encore pour du français, les nouveaux non.
                  //
                  // Et le renvoi pointe vers « Votre métier » (socle), pas vers
                  // la Veille réglementaire : c'est un module HORS SOCLE,
                  // éteint par défaut, donc le seul pointeur affiché menait
                  // jusqu'ici au module qu'il fallait justement rallumer.
                  `Défauts proposés pour votre métier (« ${verticalLabel(state.vertical)} », modifiable dans Réglages › Votre métier) — chaque module reste activable ou désactivable ici. `
                : "Réglage réservé au dirigeant — état des modules en lecture seule. "}
              Désactiver un module retire sa page du menu, ses outils de l&apos;employé virtuel
              et rend ses écrans « module désactivé » ; aucune donnée n&apos;est supprimée.
            </p>
            <ul className="device-list">
              {state.modules.map((module) => (
                <li key={module.id} className="device-row">
                  <div>
                    <strong>{module.title}</strong>{" "}
                    <span className="muted">
                      {module.active ? "activé" : "désactivé"}
                      {module.source &&
                        ` (${
                          module.source === "choix"
                            ? "votre choix"
                            : module.source === "hors_socle"
                              ? // Dire « défaut du vertical » serait faux : ce
                                // module est éteint pour tout le monde, et la
                                // seule chose qui le rallume est ce bouton.
                                "hors du socle — activable ici"
                              : "défaut du vertical"
                        })`}
                    </span>
                    <br />
                    <span className="muted">{module.description}</span>
                  </div>
                  <button
                    disabled={busy === module.id}
                    onClick={() => void toggle(module.id, !module.active)}
                  >
                    {module.active ? "Désactiver" : "Activer"}
                  </button>
                </li>
              ))}
            </ul>
            <p className="hint">Catalogue du {state.version}.</p>
            {error && <p className="warn">{error}</p>}
          </>
        )}
      </section>
    </div>
  );
}
