"use client";

import { useCallback, useEffect, useState } from "react";
import { affaireWords, verticalChoices } from "@nodaq/shared";
import { ApiError, getComplianceProfile, putComplianceProfile } from "../../../lib/api";
import { emitDomainEvent } from "../../../lib/freshness";

/*
 * Le métier de l'entreprise (4.2) — DANS LE SOCLE, et c'est tout l'objet de
 * cette page.
 *
 * Le vertical ne se déclarait que depuis la page Veille réglementaire, qui est
 * un module HORS SOCLE, éteint par défaut (`defaultOn: "aucun"`). Autrement
 * dit : un maçon devait d'abord rallumer un module qui ne l'intéresse pas pour
 * pouvoir dire qu'il est maçon. Tout le bénéfice des packs — « dire chantier
 * au maçon, événement au traiteur » — était inaccessible par défaut, et le
 * défaut a d'autant plus de poids que les packs le rendent central.
 *
 * La veille reste hors socle ; c'est le CHOIX DU MÉTIER qui rejoint le socle,
 * parce qu'il pilote le vocabulaire de la moitié du produit et les défauts de
 * modules. La même route API sert les deux écrans : `headcountOverride` est
 * facultatif côté API, donc enregistrer ici ne touche PAS l'effectif déclaré
 * dans la veille.
 */

export default function MetierPage() {
  const [vertical, setVertical] = useState("autre");
  const [saved, setSaved] = useState("autre");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * Le métier a-t-il été LU ? Tant que non, le formulaire est neutralisé.
   *
   * Sans cet état, un échec de chargement laissait l'écran afficher « Autre »
   * — une valeur par défaut d'initialisation, pas le métier du tenant — à côté
   * d'un message d'erreur générique. Enregistrer depuis là aurait écrasé le
   * vrai vertical par « Autre », c'est-à-dire perdu le métier en croyant le
   * confirmer. Ce qui n'est pas su ne s'affiche pas comme s'il l'était.
   */
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const profile = await getComplianceProfile();
      setVertical(profile.vertical);
      setSaved(profile.vertical);
      setLoaded(true);
    } catch (err) {
      // 403 = rôle non-owner : le métier est une donnée de cadrage, réservée
      // au dirigeant comme le reste du profil d'entreprise.
      setError(
        err instanceof ApiError && err.status === 403
          ? "Réservé au dirigeant."
          : "Impossible de charger le métier — rechargez la page.",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // `headcountOverride` OMIS volontairement : la route ne l'écrase que
      // s'il est fourni. Envoyer `null` ici effacerait l'effectif déclaré
      // dans la veille, sans que personne l'ait demandé.
      await putComplianceProfile({ vertical });
      setSaved(vertical);
      // Le mot affiché ailleurs (« chantier », « événement ») et les défauts
      // de modules de la nav viennent de changer.
      emitDomainEvent("profil.modifie");
      setNotice(`Enregistré — le produit dira désormais « ${affaireWords(vertical).singular} ».`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "enregistrement impossible");
    } finally {
      setBusy(false);
    }
  }

  const { cible, ancien } = verticalChoices();
  const words = affaireWords(vertical);

  return (
    <div className="page">
      <section className="card">
        <h2>Votre métier</h2>
        <p className="muted">
          Il détermine le mot que le produit emploie pour vos affaires et les modules proposés par
          défaut. Il sert aussi à la veille réglementaire, quand elle est activée.
        </p>

        {error && <p className="error-line">{error}</p>}

        <div className="form-grid">
          <label>
            Métier :{" "}
            <select
              value={vertical}
              aria-label="Métier de l'entreprise"
              // Neutralisé tant que le métier réel n'a pas été LU : un 403
              // (non-owner) ou un échec réseau laisserait sinon un formulaire
              // actif sur une valeur d'initialisation.
              disabled={!loaded}
              onChange={(e) => setVertical(e.target.value)}
            >
              {cible.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
              {/* Visible mais séparé — voir `verticalChoices()` : masquer
                  l'ancien découpage reviendrait à le supprimer en silence,
                  et le choix ne serait plus réversible. */}
              <optgroup label="Ancien découpage">
                {ancien.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <button
            className="btn"
            disabled={!loaded || busy || vertical === saved}
            onClick={() => void save()}
          >
            Enregistrer
          </button>
        </div>

        {/* L'aperçu AVANT d'enregistrer : le patron voit le mot qu'il aura,
            plutôt que de le découvrir sur ses écrans. */}
        <p className="hint">
          Aperçu : « {words.newLabel} », « {words.noneLabel} », {words.plural} en cours.
        </p>

        {notice && <p className="hint">{notice}</p>}
      </section>
    </div>
  );
}
