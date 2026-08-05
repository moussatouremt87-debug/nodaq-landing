"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  createProspect,
  deleteProspect,
  getProspectionPlan,
  getProspects,
  logProspectInteraction,
  opposeProspect,
  PROSPECT_SOURCES,
  PROSPECT_STAGES,
  updateProspect,
} from "../../lib/api";
import type { Prospect, ProspectDeletion, ProspectionPlan } from "../../lib/api";
import { useViewRefresh } from "../../lib/useFreshness";
import { emitDomainEvent } from "../../lib/freshness";

/*
 * Prospection (2.12). Deux choses sont visibles à l'écran parce qu'elles ne
 * doivent PAS être des réglages cachés :
 *  - la PROVENANCE est un champ obligatoire du formulaire, pas une option ;
 *  - l'OPPOSITION est un bouton présent sur chaque fiche, et son effet est
 *    annoncé avant d'être déclenché (il n'est pas réversible ici).
 *
 * S'y ajoute l'EFFACEMENT (art. 17). `DELETE /prospects/:id` existait depuis
 * quatre tickets et n'était appelée par AUCUN écran : l'API savait effacer une
 * fiche, anonymiser les affaires qui en dérivent, tarir la recopie des
 * contrats, purger les transcriptions — et rendre la liste motivée de ce
 * qu'elle avait dû CONSERVER. Ce compte rendu est toute la justification de ne
 * pas trancher sur les cas ambigus, et il n'avait pas de destinataire.
 *
 * L'écran est ce destinataire. Ce qui reste à faire à la main s'affiche, avec
 * son motif, jusqu'à ce que l'owner le referme.
 */

const STAGE_LABELS: Record<string, string> = {
  nouveau: "Nouveau",
  contacte: "Contacté",
  qualifie: "Qualifié",
  devis_envoye: "Devis envoyé",
  gagne: "Gagné",
  perdu: "Perdu",
};

const SOURCE_LABELS: Record<string, string> = {
  demande_entrante: "Demande entrante",
  recommandation: "Recommandation",
  salon: "Salon",
  reseau_pro: "Réseau professionnel",
  site_web: "Site web",
  saisie_manuelle: "Saisie manuelle",
};

const KIND_LABELS: Record<string, string> = {
  appel: "Appel",
  email: "E-mail",
  rdv: "Rendez-vous",
  autre: "Autre",
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function ProspectsPage() {
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [plan, setPlan] = useState<ProspectionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [source, setSource] = useState("");
  /*
   * L'effacement est réservé au dirigeant (`ownerRoute`). Optimiste, comme
   * ailleurs : on montre le bouton, et un 403 le retire. Le cacher d'emblée
   * demanderait un appel de plus au chargement de chaque écran.
   */
  const [isOwner, setIsOwner] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Compte rendu du dernier effacement — il RESTE tant qu'on ne le ferme pas. */
  const [rapport, setRapport] = useState<{ nom: string; res: ProspectDeletion } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await getProspects();
      setProspects(list.prospects);
      setTruncated(list.truncated);
      setPlan(await getProspectionPlan().catch(() => null));
    } catch {
      setError("prospection indisponible — réessayez");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useViewRefresh(["prospects"], () => void refresh());

  async function add(): Promise<void> {
    setError(null);
    if (name.trim() === "") {
      setError("le nom est obligatoire");
      return;
    }
    // Provenance EXIGÉE côté écran comme côté API : on refuse d'enregistrer
    // une personne dont on ne saurait pas dire d'où vient sa fiche.
    if (source === "") {
      setError("indiquez d'où vient cette fiche — c'est une obligation, pas un détail");
      return;
    }
    try {
      await createProspect({
        name: name.trim(),
        source,
        ...(company.trim() ? { company: company.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
      });
      setName("");
      setCompany("");
      setEmail("");
      setSource("");
      await refresh();
      emitDomainEvent("prospect.modifie");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "enregistrement impossible");
    }
  }

  async function oppose(prospect: Prospect): Promise<void> {
    const confirmed = window.confirm(
      `Enregistrer l'opposition de ${prospect.name} ?\n\n` +
        "Ses coordonnées et les comptes rendus seront effacés, et elle ne " +
        "réapparaîtra dans aucune liste de relance. Cette action ne peut pas " +
        "être annulée depuis le produit.",
    );
    if (!confirmed) return;
    try {
      await opposeProspect(prospect.id);
      await refresh();
      emitDomainEvent("prospect.modifie");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "opposition impossible");
    }
  }

  async function effacer(prospect: Prospect): Promise<void> {
    /*
     * Ce que la confirmation DOIT dire : pas « êtes-vous sûr » mais ce qui va
     * se passer. L'effacement touche quatre choses au-delà de la fiche, et
     * l'une d'elles — les conversations de l'agent — surprendrait tout le
     * monde si elle n'était pas annoncée : le chat repart à zéro pour
     * l'équipe entière.
     */
    const confirmed = window.confirm(
      `Effacer définitivement la fiche de ${prospect.name} ?\n\n` +
        "• sa fiche et son journal de contacts sont supprimés\n" +
        "• son nom et son adresse sont retirés des chantiers jamais contractés\n" +
        "• les chantiers portant une trace d'exécution sont CONSERVÉS, et listés ensuite\n" +
        "• les contrats liés perdent son nom, pour qu'il ne revienne pas\n" +
        "• les conversations avec l'assistant sont effacées : le chat repart à zéro\n\n" +
        "Cette action ne peut pas être annulée.",
    );
    if (!confirmed) return;
    setBusyId(prospect.id);
    setError(null);
    try {
      const res = await deleteProspect(prospect.id);
      setRapport({ nom: prospect.name, res });
      await refresh();
      // Un effacement périme les affaires, les contrats et le cockpit : sans
      // cet événement, un autre onglet continuerait d'afficher le nom effacé.
      emitDomainEvent("prospect.efface");
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setIsOwner(false);
        setError("Réservé au dirigeant.");
      } else {
        setError(err instanceof ApiError ? err.message : "effacement impossible");
      }
    } finally {
      setBusyId(null);
    }
  }

  async function logContact(prospect: Prospect, kind: string): Promise<void> {
    try {
      await logProspectInteraction(prospect.id, { kind, occurredAt: today() });
      await refresh();
      emitDomainEvent("prospect.modifie");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "contact non consigné");
    }
  }

  async function moveStage(prospect: Prospect, stage: string): Promise<void> {
    try {
      await updateProspect(prospect.id, { stage });
      await refresh();
      emitDomainEvent("prospect.modifie");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "étape non modifiée");
    }
  }

  /*
   * Les fiches dont la conservation est dépassée, marquées LÀ OÙ ON AGIT.
   * L'écran annonçait « N fiches à supprimer » dans un encart séparé sans
   * jamais dire lesquelles : le compteur envoyait chercher, il n'aidait pas.
   */
  const perimees = new Set(
    [...(plan?.retentionAlerts ?? []), ...(plan?.expiredOptedOut ?? [])].map(
      (alerte) => alerte.id,
    ),
  );

  return (
    <div className="page">
      <section className="card">
        <h2>Nouvelle fiche</h2>
        <div className="form-grid">
          <input placeholder="Nom" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            placeholder="Société (optionnel)"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          />
          <input
            placeholder="E-mail (optionnel)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label>
            Provenance :{" "}
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">— obligatoire —</option>
              {PROSPECT_SOURCES.map((value) => (
                <option key={value} value={value}>
                  {SOURCE_LABELS[value] ?? value}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" onClick={() => void add()}>
            Enregistrer
          </button>
        </div>
        <p className="muted">
          La provenance est obligatoire : sans elle, impossible de dire à la personne d&apos;où
          vient sa fiche si elle le demande. Les fichiers de prospection achetés ne sont pas pris
          en charge.
        </p>
        {error && <p className="warn">{error}</p>}
      </section>

      {plan && (
        <section className="card">
          <h2>À relancer</h2>
          {plan.followups.length === 0 ? (
            <p className="muted">Aucune relance au-delà des délais.</p>
          ) : (
            <ul className="device-list">
              {plan.followups.map((followup) => (
                <li key={followup.id} className="device-row">
                  <div>
                    <strong>{followup.name}</strong>{" "}
                    <span className="muted">
                      {followup.company ? `${followup.company} · ` : ""}
                      {STAGE_LABELS[followup.stage] ?? followup.stage}
                    </span>
                    <br />
                    <span className="muted">{followup.reason}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="muted">
            Pipeline :{" "}
            {PROSPECT_STAGES.map(
              (stage) => `${STAGE_LABELS[stage] ?? stage} ${plan.pipeline[stage] ?? 0}`,
            ).join(" · ")}
            {plan.optedOutCount > 0 &&
              ` — ${plan.optedOutCount} personne(s) opposée(s) à la prospection, exclue(s) de toute liste.`}
          </p>
          {plan.retentionAlerts.length > 0 && (
            <p className="warn">
              {plan.retentionAlerts.length} fiche(s) sans contact depuis plus de 36 mois : la
              durée de conservation recommandée est dépassée. Elles sont signalées dans la liste
              ci-dessous, avec le bouton pour les effacer.
              {plan.expiredOptedOutCount > 0 &&
                ` S'y ajoutent ${plan.expiredOptedOutCount} fiche(s) opposée(s) également périmée(s), signalée(s) elles aussi.`}
            </p>
          )}
          <p className="warn">
            {plan.label} (règles du {plan.rulesVersion})
          </p>
        </section>
      )}

      {rapport !== null && (
        <section className="card">
          <h2>Fiche de {rapport.nom} effacée</h2>
          {/* CE QUI A ÉTÉ FAIT — des nombres, jamais un « c'est bon ». */}
          <ul className="device-list">
            <li className="device-row">
              {rapport.res.affairesAnonymisees} chantier(s) anonymisé(s) — nom, adresse et
              coordonnées retirés.
            </li>
            <li className="device-row">
              {rapport.res.contratsAnonymises} contrat(s) anonymisé(s) — le nom ne reviendra
              plus à la prochaine matérialisation.
            </li>
            <li className="device-row">
              {rapport.res.conversationsEffacees} conversation(s) avec l&apos;assistant
              effacée(s) — le chat repart à zéro.
            </li>
          </ul>

          {/*
            CE QU'IL RESTE, ET POURQUOI. C'est la raison d'être de tout ce
            ticket : sans cette liste, une conservation motivée devient une
            conservation muette, et personne ne sait qu'il reste du travail.
          */}
          {rapport.res.affairesConservees.length > 0 && (
            <>
              <p className="warn">
                {rapport.res.affairesConservees.length} chantier(s) CONSERVÉ(S) — à relire :
              </p>
              <ul className="device-list">
                {rapport.res.affairesConservees.map((affaire) => (
                  <li key={affaire.id} className="device-row">
                    <strong>{affaire.reference}</strong> {affaire.label}
                    <br />
                    <span className="muted">{affaire.motif}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {rapport.res.contratsConserves.length > 0 && (
            <>
              <p className="warn">
                {rapport.res.contratsConserves.length} contrat(s) CONSERVÉ(S) — à relire :
              </p>
              <ul className="device-list">
                {rapport.res.contratsConserves.map((contrat) => (
                  <li key={contrat.id} className="device-row">
                    <strong>{contrat.label}</strong>
                    <br />
                    <span className="muted">{contrat.motif}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {rapport.res.contratsSansFiche > 0 && (
            <p className="warn">
              {rapport.res.contratsSansFiche} contrat(s) portent un nom de client sans lien vers
              une fiche : aucun effacement ne peut les atteindre. Rattachez-les depuis l&apos;écran
              Contrats.
            </p>
          )}

          {/*
            Le compte rendu n'est PAS persisté : c'est une réponse HTTP, pas une
            tâche. Le taire ferait perdre au premier rechargement une liste que
            l'owner est censé traiter à la main.
          */}
          <p className="warn">
            Ce compte rendu n&apos;est pas conservé : notez ce qu&apos;il reste à faire avant de
            quitter cet écran.
          </p>
          <button onClick={() => setRapport(null)}>Fermer</button>
        </section>
      )}

      <section className="card">
        <h2>Fiches ({prospects.length})</h2>
        {truncated && (
          <p className="warn">
            Liste tronquée : seules les 500 fiches les plus récentes sont affichées.
          </p>
        )}
        <ul className="device-list">
          {prospects.map((prospect) => (
            <li key={prospect.id} className="device-row">
              <div>
                <strong>{prospect.name}</strong>{" "}
                <span className="muted">
                  {prospect.company ? `${prospect.company} · ` : ""}
                  {SOURCE_LABELS[prospect.source] ?? prospect.source}
                </span>
                {(prospect.email || prospect.phone || prospect.notes) && (
                  <>
                    <br />
                    <span className="muted">
                      {[prospect.email, prospect.phone, prospect.notes].filter(Boolean).join(" · ")}
                    </span>
                  </>
                )}
                {perimees.has(prospect.id) && (
                  <>
                    <br />
                    <span className="warn">
                      Sans contact depuis plus de 36 mois — durée de conservation dépassée.
                    </span>
                  </>
                )}
                {prospect.optedOut ? (
                  <>
                    <br />
                    <span className="warn">
                      Opposée à la prospection — conservée uniquement pour ne plus la recontacter.
                    </span>
                    {/*
                      L'effacement reste possible sur une fiche OPPOSÉE, et
                      c'est délibéré : l'opposition minimise (on garde de quoi
                      ne plus contacter), l'effacement supprime. Une personne
                      qui s'est opposée puis demande son effacement ne doit pas
                      buter sur un écran qui ne lui offre plus rien.
                    */}
                    {isOwner && (
                      <>
                        {" "}
                        <button
                          disabled={busyId === prospect.id}
                          onClick={() => void effacer(prospect)}
                        >
                          Effacer définitivement
                        </button>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <br />
                    <select
                      value={prospect.stage}
                      onChange={(e) => void moveStage(prospect, e.target.value)}
                    >
                      {PROSPECT_STAGES.map((stage) => (
                        <option key={stage} value={stage}>
                          {STAGE_LABELS[stage] ?? stage}
                        </option>
                      ))}
                    </select>{" "}
                    {Object.entries(KIND_LABELS).map(([kind, label]) => (
                      <button key={kind} onClick={() => void logContact(prospect, kind)}>
                        + {label}
                      </button>
                    ))}{" "}
                    <button onClick={() => void oppose(prospect)}>Ne plus contacter</button>{" "}
                    {isOwner && (
                      <button
                        disabled={busyId === prospect.id}
                        onClick={() => void effacer(prospect)}
                      >
                        Effacer définitivement
                      </button>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
