"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { formatEuroCents, getMorningBrief } from "../../lib/api";
import type { MorningBrief } from "../../lib/api";
import { useFreshness } from "../../lib/useFreshness";

/*
 * F5 — le brief du matin.
 *
 * Lu à 7 h, sur un téléphone, avant le café. Trois lignes qui décident d'une
 * journée. Donc : rien de décoratif, chaque ligne mène quelque part, et ce
 * qu'on n'a pas pu regarder est écrit noir sur blanc.
 *
 * Un brief qu'on apprend à survoler ne sert plus à rien — c'est pourquoi une
 * matinée calme s'affiche comme telle au lieu d'être meublée.
 */

const SEVERITY_LABELS: Record<string, string> = {
  urgent: "Urgent",
  attention: "À surveiller",
  info: "Bon à savoir",
};

export default function BriefPage() {
  const [brief, setBrief] = useState<MorningBrief | null>(null);

  const load = useCallback(async () => {
    setBrief(await getMorningBrief());
  }, []);

  const freshness = useFreshness(["brief"], load);

  return (
    <>
      <h1 className="page-title">Ce matin</h1>
      <p className="page-sub">
        Ce qui a changé et ce qui vous attend. Rien n&apos;est calculé ici : chaque chiffre vient
        d&apos;un écran que vous pouvez ouvrir.
      </p>
      <p className="hint">
        {freshness.label}
        {freshness.stale && " — vérifiez"} ·{" "}
        <button className="link-button" onClick={freshness.refresh}>
          rafraîchir
        </button>
      </p>

      {brief === null ? (
        <p className="hint">Chargement…</p>
      ) : brief.kind === "calme" ? (
        <div className="card" style={{ maxWidth: 560 }}>
          <span className="overline">Rien d&apos;urgent</span>
          <p className="hint" style={{ margin: "6px 0 0" }}>
            {/* Meubler une matinée calme apprend à ne plus lire le brief. */}
            Aucune alerte ce matin. Bonne journée.
          </p>
        </div>
      ) : (
        <div style={{ maxWidth: 560 }}>
          {brief.items.map((item) => (
            <Link
              key={item.kind}
              href={item.href}
              className={item.severity === "urgent" ? "card accent" : "card"}
              style={{ display: "block", marginBottom: 10 }}
            >
              <span className="overline">{SEVERITY_LABELS[item.severity] ?? item.severity}</span>
              <div style={{ fontWeight: 600, margin: "4px 0" }}>{item.label}</div>
              {item.amountCents !== null && (
                <span className="hint" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {formatEuroCents(item.amountCents)}
                  {/* Le qualificatif vient de l'API et voyage AVEC le chiffre :
                      « −1 500 € » sous « 3 affaires perdent de l'argent » se
                      lirait comme un total, et un plafond comme une marge. */}
                  {item.amountNote !== null && ` — ${item.amountNote}`}
                </span>
              )}
            </Link>
          ))}
        </div>
      )}

      {/* Ce qui n'a pas été regardé. Sans ça, « rien d'urgent » voudrait dire
          « rien vu », et le patron croirait le produit muet plutôt qu'aveugle. */}
      {brief !== null && brief.blindSpots.length > 0 && (
        <div className="card" style={{ maxWidth: 560, marginTop: 14 }}>
          <span className="overline">Non regardé ce matin</span>
          <ul className="hint" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {/* Clé = domaine + raison : un même domaine porte plusieurs angles
                morts (impayés × avertissements FEC, affaires × trois limites).
                Une clé dupliquée, c'est React qui réconcilie de travers — sur
                la liste dont tout l'argument est de ne rien taire. */}
            {brief.blindSpots.map((spot) => (
              <li key={`${spot.area}|${spot.why}`}>
                {spot.area} — {spot.why}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
