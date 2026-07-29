"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  ApiError,
  createFixedAsset,
  formatEuroCents,
  getFixedAssetPlan,
  getFixedAssets,
  updateFixedAsset,
} from "../../lib/api";
import type { FixedAsset, FixedAssetRegistry } from "../../lib/api";

/*
 * Registre des immobilisations (2.19) — owner only (l'API répond 403 sinon).
 * Un amortissement ne décaisse rien : la page montre la VNC, l'usure, le MUR
 * DE RENOUVELLEMENT (scénario CAPEX) et une ESTIMATION d'effet IS toujours
 * labellisée « à valider avec votre expert-comptable ».
 */

const CATEGORIES = [
  ["informatique", "Matériel informatique"],
  ["logiciel", "Logiciel"],
  ["vehicule", "Véhicule"],
  ["materiel", "Matériel et outillage"],
  ["mobilier", "Mobilier"],
  ["agencement", "Agencements"],
] as const;

export default function ImmobilisationsPage() {
  const [registry, setRegistry] = useState<FixedAssetRegistry | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [plan, setPlan] = useState<{ id: string; lines: { year: number; dotationCents: number; endBookValueCents: number }[] } | null>(null);
  const [form, setForm] = useState({ label: "", category: "materiel", inServiceDate: "", amountEur: "", durationYears: "5" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRegistry(await getFixedAssets());
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else setError("registre indisponible — réessayez");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function openPlan(asset: FixedAsset): Promise<void> {
    const lines = await getFixedAssetPlan(asset.id).catch(() => []);
    setPlan({ id: asset.id, lines });
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    const cents = Math.round(Number(form.amountEur.replace(",", ".")) * 100);
    const months = Math.round(Number(form.durationYears) * 12);
    if (!form.label || !form.inServiceDate || !Number.isFinite(cents) || cents <= 0 || months <= 0) {
      setError("formulaire incomplet");
      return;
    }
    setBusy(true);
    try {
      await createFixedAsset({
        label: form.label,
        category: form.category,
        inServiceDate: form.inServiceDate,
        baseCents: cents,
        durationMonths: months,
      });
      setForm({ label: "", category: "materiel", inServiceDate: "", amountEur: "", durationYears: "5" });
      await refresh();
    } catch {
      setError("création impossible");
    } finally {
      setBusy(false);
    }
  }

  async function dispose(asset: FixedAsset): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    await updateFixedAsset(asset.id, { status: "CEDE", disposedAt: today }).catch(() => undefined);
    await refresh();
  }

  if (forbidden) {
    return (
      <div className="page">
        <section className="card">
          <h2>Immobilisations</h2>
          <p className="muted">Réservé au dirigeant (données financières du patrimoine).</p>
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <section className="card">
        <h2>Registre</h2>
        {registry === null ? (
          <p className="muted">Chargement…</p>
        ) : registry.assets.length === 0 ? (
          <p className="muted">
            Aucune immobilisation — importez votre FEC (les comptes 2x/28x deviennent des
            propositions dans la file de validation) ou photographiez une facture
            d&apos;équipement au Classeur.
          </p>
        ) : (
          <>
            <p>
              VNC totale (actifs) : <strong>{formatEuroCents(registry.totalBookValueCents)}</strong>
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>Libellé</th>
                  <th>Catégorie</th>
                  <th>Mise en service</th>
                  <th>Base</th>
                  <th>VNC</th>
                  <th>Usure</th>
                  <th>Fin de plan</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {registry.assets.map((asset) => (
                  <tr key={asset.id} className={asset.status !== "ACTIF" ? "muted" : undefined}>
                    <td onClick={() => void openPlan(asset)} style={{ cursor: "pointer" }}>
                      {asset.label}
                      {asset.status !== "ACTIF" && ` (${asset.status.toLowerCase()})`}
                    </td>
                    <td>{asset.category}</td>
                    <td>{asset.inServiceDate}</td>
                    <td>{formatEuroCents(asset.baseCents)}</td>
                    <td>{formatEuroCents(asset.bookValueCents)}</td>
                    <td>
                      <span
                        className="wear-bar"
                        style={{
                          display: "inline-block",
                          width: 60,
                          height: 8,
                          background: `linear-gradient(to right, ${asset.wearRatio >= 0.8 ? "#dc2626" : "#0f172a"} ${Math.round(asset.wearRatio * 100)}%, #e2e8f0 0)`,
                          borderRadius: 4,
                        }}
                        title={`${Math.round(asset.wearRatio * 100)} %`}
                      />
                    </td>
                    <td>{asset.planEndYear ?? "—"}</td>
                    <td>
                      {asset.status === "ACTIF" && (
                        <button onClick={() => void dispose(asset)}>Céder</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {plan && (
          <div>
            <h3>Plan d&apos;amortissement</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Exercice</th>
                  <th>Dotation</th>
                  <th>VNC fin d&apos;exercice</th>
                </tr>
              </thead>
              <tbody>
                {plan.lines.map((line) => (
                  <tr key={line.year}>
                    <td>{line.year}</td>
                    <td>{formatEuroCents(line.dotationCents)}</td>
                    <td>{formatEuroCents(line.endBookValueCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">
              Les dotations sont des charges comptables : elles ne décaissent rien — seul
              l&apos;effet IS estimé et le renouvellement touchent la trésorerie.
            </p>
          </div>
        )}
      </section>

      {registry && (
        <section className="card">
          <h3>Mur de renouvellement (24 mois)</h3>
          {registry.renewalWall.length === 0 ? (
            <p className="muted">Aucune fin de plan dans les 24 prochains mois.</p>
          ) : (
            <ul>
              {registry.renewalWall.map((quarter) => (
                <li key={quarter.quarter}>
                  <strong>{quarter.quarter}</strong> : {formatEuroCents(quarter.capexCents)} —{" "}
                  {quarter.assets.map((a) => a.label).join(", ")}
                </li>
              ))}
            </ul>
          )}
          <p className="muted">
            Scénario CAPEX (montant = base historique, éditable par immobilisation) — jamais
            imposé à la projection.
          </p>
          <h3>Effet IS des dotations {new Date().getUTCFullYear()}</h3>
          <p>
            Dotations de l&apos;exercice :{" "}
            <strong>{formatEuroCents(registry.isImpact.currentYearDepreciationCents)}</strong> —
            économie d&apos;IS estimée :{" "}
            <strong>{formatEuroCents(registry.isImpact.estimatedTaxSavingCents)}</strong> (taux
            marginal {Math.round(registry.isImpact.marginalRate * 100)} %). Prochains acomptes :{" "}
            {registry.isImpact.upcomingInstallments.join(", ")}.
          </p>
          <p className="warn">{registry.isImpact.label}</p>
        </section>
      )}

      <section className="card">
        <h3>Ajouter manuellement</h3>
        <form onSubmit={(event) => void submit(event)} className="form-grid">
          <input
            placeholder="Libellé (ex. Fourgon atelier)"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
          />
          <select
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          >
            {CATEGORIES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={form.inServiceDate}
            onChange={(e) => setForm({ ...form, inServiceDate: e.target.value })}
          />
          <input
            placeholder="Base amortissable (€ HT)"
            inputMode="decimal"
            value={form.amountEur}
            onChange={(e) => setForm({ ...form, amountEur: e.target.value })}
          />
          <input
            placeholder="Durée (années)"
            inputMode="numeric"
            value={form.durationYears}
            onChange={(e) => setForm({ ...form, durationYears: e.target.value })}
          />
          <button className="primary" disabled={busy}>
            {busy ? "Ajout…" : "Ajouter au registre"}
          </button>
        </form>
        {error && <p className="warn">{error}</p>}
      </section>
    </div>
  );
}
