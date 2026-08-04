"use client";

import { useCallback, useEffect, useState } from "react";
import { verticalChoices } from "@nodaq/shared";
import { emitDomainEvent } from "../../lib/freshness";
import {
  ApiError,
  getComplianceProfile,
  getRegulatoryWatch,
  putComplianceProfile,
} from "../../lib/api";
import type { ComplianceProfile, RegulatoryWatch } from "../../lib/api";

/*
 * Veille réglementaire (3.7) — owner only (profil stratégique + effectif RH).
 * Obligations issues d'un catalogue VERSIONNÉ daté et sourcé, applicabilité
 * expliquée (vertical + effectif) ; information générale, jamais un conseil
 * juridique — le label reste affiché en permanence.
 */

/*
 * Les métiers viennent du PACK (4.2), en DEUX GROUPES — `verticalChoices()`.
 *
 * La liste écrite ici avait cessé d'être vraie : elle ne connaissait aucun des
 * cinq métiers de la cible du pivot, si bien qu'un paysagiste ou un traiteur ne
 * pouvait tout simplement pas se déclarer. C'est la règle d'architecture de
 * l'ADR-007 dans sa forme la plus concrète : un vertical est une donnée, et une
 * donnée ne se recopie pas dans un écran.
 *
 * Les DEUX groupes sont rendus, toujours. Ne montrer que la cible rendait
 * `retail` inatteignable pour qui n'y était pas déjà, donc plus personne ne
 * pouvait se déclarer commerçant ni recevoir l'obligation d'information sur
 * les prix : un vertical qu'on ne peut plus choisir est un vertical supprimé
 * en silence.
 *
 * Ce n'est PAS le point d'entrée principal — cet écran appartient à un module
 * hors socle. Le choix du métier vit dans `/reglages/metier`.
 */

const STATUS_LABELS: Record<string, string> = {
  echeance_proche: "échéance proche",
  a_venir: "à venir",
  en_vigueur: "en vigueur",
};

export default function ReglementairePage() {
  const [forbidden, setForbidden] = useState(false);
  const [profile, setProfile] = useState<ComplianceProfile | null>(null);
  const [watch, setWatch] = useState<RegulatoryWatch | null>(null);
  const [vertical, setVertical] = useState("autre");
  const [headcount, setHeadcount] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const nextProfile = await getComplianceProfile();
      setProfile(nextProfile);
      setVertical(nextProfile.vertical);
      setHeadcount(
        nextProfile.headcountOverride !== null ? String(nextProfile.headcountOverride) : "",
      );
      setWatch(await getRegulatoryWatch().catch(() => null));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else setError("veille indisponible — réessayez");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function saveProfile(): Promise<void> {
    setError(null);
    const trimmed = headcount.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed !== null && (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000)) {
      setError("effectif entre 0 et 10 000 (ou vide)");
      return;
    }
    try {
      await putComplianceProfile({ vertical, headcountOverride: parsed });
      /*
       * Le vertical qu'on vient d'écrire pilote le MOT affiché ailleurs
       * (« chantier », « événement », « intervention ») et les défauts de
       * modules de la navigation. `refresh()` ne rafraîchit que cette page :
       * sans cet événement, un paysagiste qui se déclare voit encore
       * « affaire » sur ses chantiers jusqu'au rechargement.
       */
      emitDomainEvent("profil.modifie");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "enregistrement impossible");
    }
  }

  // Déstructuré une fois : `verticalChoices()` appelée deux fois dans le JSX
  // recalculait la même liste à chaque rendu.
  const { cible, ancien } = verticalChoices();

  if (forbidden) {
    return (
      <div className="page">
        <section className="card">
          <h2>Veille réglementaire</h2>
          <p className="muted">Réservé au dirigeant (profil stratégique de l&apos;entreprise).</p>
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <section className="card">
        <h2>Profil de l&apos;entreprise</h2>
        <div className="form-grid">
          <label>
            Vertical métier :{" "}
            <select value={vertical} onChange={(e) => setVertical(e.target.value)}>
              {cible.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
              {/* Visible mais SÉPARÉ : le groupe dit lequel est d'actualité
                  sans fermer la porte. Masquer l'ancien découpage revenait à
                  le supprimer en silence. */}
              <optgroup label="Ancien découpage">
                {ancien.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label>
            Effectif déclaré :{" "}
            <input
              style={{ width: 90 }}
              inputMode="numeric"
              placeholder={
                profile?.derivedHeadcount !== null && profile?.derivedHeadcount !== undefined
                  ? `équipe : ${profile.derivedHeadcount}`
                  : "inconnu"
              }
              value={headcount}
              onChange={(e) => setHeadcount(e.target.value)}
            />
          </label>
          <button className="primary" onClick={() => void saveProfile()}>
            Enregistrer
          </button>
        </div>
        <p className="muted">
          Sans effectif déclaré, l&apos;effectif actif de la page Équipe est utilisé ; sinon les
          obligations à seuil restent affichées « à confirmer ».
        </p>
        {error && <p className="warn">{error}</p>}
      </section>

      <section className="card">
        <h2>Obligations applicables</h2>
        {watch === null ? (
          <p className="muted">Veille indisponible.</p>
        ) : (
          <>
            <p className="muted">
              Effectif utilisé : {watch.profile.headcount ?? "inconnu"}{" "}
              {watch.profile.headcountSource === "declare"
                ? "(déclaré)"
                : watch.profile.headcountSource === "equipe"
                  ? "(estimé depuis les fiches actives de la page Équipe — saisie possiblement partielle)"
                  : "(non renseigné — obligations à seuil affichées « à confirmer »)"}{" "}
              — l&apos;effectif légal se calcule en moyenne annuelle (art. L130-1 du code de la
              sécurité sociale) : ce chiffre est une approximation.
            </p>
            <ul className="device-list">
              {watch.matches.map((match) => (
                <li key={match.id} className="device-row" title={match.reason}>
                  <div>
                    <strong>{match.title}</strong>{" "}
                    {match.status === "echeance_proche" ? (
                      <strong style={{ color: "#dc2626" }}>
                        {match.nextDeadline} ({match.daysUntil} j)
                      </strong>
                    ) : (
                      <span className="muted">
                        {STATUS_LABELS[match.status] ?? match.status}
                        {match.nextDeadline ? ` · ${match.nextDeadline}` : ""}
                      </span>
                    )}
                    {match.applies === "peut_etre" && (
                      <span className="muted"> · à confirmer (effectif non renseigné)</span>
                    )}
                    <br />
                    <span className="muted">{match.obligation}</span>
                    <br />
                    <a href={match.source.url} target="_blank" rel="noreferrer">
                      {match.source.label}
                    </a>
                  </div>
                </li>
              ))}
            </ul>
            <p className="warn">
              {watch.label} (catalogue du {watch.version})
            </p>
          </>
        )}
      </section>
    </div>
  );
}
