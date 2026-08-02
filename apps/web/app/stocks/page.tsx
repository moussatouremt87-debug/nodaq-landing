"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  ApiError,
  createStockItem,
  deleteStockItem,
  listStockItems,
  listStockMovements,
  moveStock,
  updateStockItem,
} from "../../lib/api";
import type { StockItem, StockMovement } from "../../lib/api";
import { emitDomainEvent } from "../../lib/freshness";

/*
 * Suivi des stocks (ticket 3.2) : tout membre ajuste les quantités (l'employé
 * de terrain sort du matériel du dépôt), l'owner gère le référentiel (articles,
 * seuils, suppression). Chaque ajustement est journalisé en append-only.
 */

export default function StocksPage() {
  const [items, setItems] = useState<StockItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [movements, setMovements] = useState<StockMovement[] | null>(null);
  const [isOwner, setIsOwner] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newUnit, setNewUnit] = useState("");
  const [newThreshold, setNewThreshold] = useState("");
  const [thresholdDraft, setThresholdDraft] = useState("");
  const [costDraft, setCostDraft] = useState("");
  const [scenarioPct, setScenarioPct] = useState("10");
  const [hasMore, setHasMore] = useState(false);

  const selected = items.find((i) => i.id === selectedId) ?? null;

  const refresh = useCallback(() => {
    listStockItems()
      .then((result) => {
        setItems(result.items);
        setHasMore(result.hasMore);
      })
      .catch(() => undefined);
  }, []);

  useEffect(refresh, [refresh]);

  function select(item: StockItem): void {
    setSelectedId(item.id);
    setThresholdDraft(String(item.alertThreshold));
    setCostDraft(
      item.unitCostCents !== undefined ? (item.unitCostCents / 100).toFixed(2) : "",
    );
    setMovements(null);
    setNotice(null);
    listStockMovements(item.id)
      .then(setMovements)
      .catch(() => setMovements([]));
  }

  function patchLocal(updated: StockItem): void {
    setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
  }

  async function adjust(item: StockItem, delta: number): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      patchLocal(await moveStock(item.id, delta));
      // Le cockpit affiche les alertes de stock : elles changent ici.
      emitDomainEvent("stock.modifie");
      if (selectedId === item.id) {
        listStockMovements(item.id)
          .then(setMovements)
          .catch(() => undefined);
      }
    } catch (error) {
      setNotice(
        error instanceof ApiError && error.status === 409
          ? "Stock insuffisant pour cette sortie."
          : "Échec de l'ajustement.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function create(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const threshold = newThreshold === "" ? 0 : Number.parseInt(newThreshold, 10);
      await createStockItem({
        name: newName.trim(),
        ...(newUnit.trim() ? { unit: newUnit.trim() } : {}),
        ...(Number.isFinite(threshold) && threshold > 0 ? { alertThreshold: threshold } : {}),
      });
      setNewName("");
      setNewUnit("");
      setNewThreshold("");
      refresh();
      emitDomainEvent("stock.modifie");
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setIsOwner(false);
        setNotice("Création réservée au rôle owner.");
      } else if (error instanceof ApiError && error.status === 409) {
        setNotice("Un article porte déjà ce nom.");
      } else {
        setNotice("Échec de la création.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveThreshold(): Promise<void> {
    if (!selected) return;
    const threshold = Number.parseInt(thresholdDraft, 10);
    if (!Number.isFinite(threshold) || threshold < 0) {
      setNotice("Seuil invalide.");
      return;
    }
    const cost =
      costDraft.trim() === ""
        ? undefined
        : Math.round(Number.parseFloat(costDraft.replace(",", ".")) * 100);
    if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) {
      setNotice("Coût unitaire invalide.");
      return;
    }
    setBusy(true);
    try {
      patchLocal(
        await updateStockItem(selected.id, {
          alertThreshold: threshold,
          ...(cost !== undefined ? { unitCostCents: cost } : {}),
        }),
      );
      emitDomainEvent("stock.modifie");
      setNotice("Réglages enregistrés.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) setIsOwner(false);
      setNotice(
        error instanceof ApiError && error.status === 403
          ? "Modification réservée au rôle owner."
          : "Échec de l'enregistrement.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!selected) return;
    if (!window.confirm(`Supprimer « ${selected.name} » et son historique ?`)) return;
    setBusy(true);
    try {
      await deleteStockItem(selected.id);
      setSelectedId(null);
      refresh();
      emitDomainEvent("stock.modifie");
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) setIsOwner(false);
      setNotice(
        error instanceof ApiError && error.status === 403
          ? "Suppression réservée au rôle owner."
          : "Échec de la suppression.",
      );
    } finally {
      setBusy(false);
    }
  }

  const alerts = items.filter((i) => i.belowThreshold);

  // Valorisation (3.3) — l'API n'expose les coûts qu'à l'owner : la carte
  // n'apparaît que si les champs sont présents. Simulation côté client,
  // même formule que l'outil agent (explicable).
  const valuedItems = items.filter((i) => i.valueCents !== undefined);
  const totalValueCents = valuedItems.reduce((sum, i) => sum + (i.valueCents ?? 0), 0);
  const parsedPct = Number.parseFloat(scenarioPct.replace(",", "."));
  const scenarioValid = Number.isFinite(parsedPct) && parsedPct >= -90 && parsedPct <= 500;
  const simulatedValueCents = scenarioValid
    ? valuedItems.reduce(
        (sum, i) =>
          sum +
          i.quantity * Math.max(0, Math.round((i.unitCostCents ?? 0) * (1 + parsedPct / 100))),
        0,
      )
    : totalValueCents;

  function euro(cents: number): string {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(
      cents / 100,
    );
  }

  return (
    <>
      <h1 className="page-title">Stocks</h1>
      <p className="page-sub">
        Suivez le matériel du dépôt : chaque entrée/sortie est journalisée, et les articles sous
        leur seuil remontent en alerte dans le cockpit.
      </p>

      {alerts.length > 0 && (
        <div className="card accent" style={{ marginBottom: 18 }}>
          <span className="overline">
            ⚠ {alerts.length} article{alerts.length > 1 ? "s" : ""} sous le seuil
          </span>
          <p className="hint" style={{ margin: "4px 0 0" }}>
            {alerts.map((i) => `${i.name} (${i.quantity} ${i.unit})`).join(" · ")}
          </p>
        </div>
      )}

      {valuedItems.length > 0 && totalValueCents > 0 && (
        <div className="card" style={{ marginBottom: 18, maxWidth: 560 }}>
          <span className="overline">Valorisation du stock — simulation prix matières</span>
          <p className="hint" style={{ margin: "4px 0 10px" }}>
            Valeur de remplacement actuelle : <strong>{euro(totalValueCents)}</strong> (aux coûts
            unitaires renseignés{hasMore ? " — valorisation PARTIELLE : 500 premiers articles" : ""}
            ).
          </p>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className="hint">Si les prix matières varient de</span>
            <input
              value={scenarioPct}
              onChange={(e) => setScenarioPct(e.target.value)}
              inputMode="decimal"
              style={{ width: 70 }}
              aria-label="Variation en pourcentage"
            />
            <span className="hint">% :</span>
            {scenarioValid ? (
              <strong>
                {euro(simulatedValueCents)} ({simulatedValueCents >= totalValueCents ? "+" : "−"}
                {euro(Math.abs(simulatedValueCents - totalValueCents))})
              </strong>
            ) : (
              <span className="hint">variation entre −90 et +500</span>
            )}
          </div>
          <p className="hint" style={{ margin: "8px 0 0" }}>
            Simulation explicable : quantités × coûts de remplacement. Demandez à l&apos;employé
            Compta « et si le cuivre prend 10 % ? » pour un scénario par matière.
          </p>
        </div>
      )}

      <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 380px", minWidth: 320 }}>
          {items.length === 0 && (
            <p className="hint">Aucun article — créez le premier ci-contre (owner).</p>
          )}
          {items.map((item) => (
            <div
              key={item.id}
              className={item.id === selectedId ? "card accent" : "card"}
              style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8 }}
            >
              <button
                type="button"
                onClick={() => select(item)}
                style={{ flex: 1, minWidth: 0, textAlign: "left", cursor: "pointer", background: "none", border: "none", padding: 0 }}
              >
                <strong style={{ display: "block" }}>
                  {item.belowThreshold ? "⚠ " : ""}
                  {item.name}
                </strong>
                <span className="hint">
                  {item.quantity} {item.unit}
                  {item.alertThreshold > 0 ? ` · seuil ${item.alertThreshold}` : ""}
                  {item.sku ? ` · ${item.sku}` : ""}
                </span>
              </button>
              <button disabled={busy} onClick={() => void adjust(item, -1)} aria-label="Sortie de 1">
                −1
              </button>
              <button disabled={busy} onClick={() => void adjust(item, 1)} aria-label="Entrée de 1">
                +1
              </button>
            </div>
          ))}
        </div>

        <div style={{ flex: "1 1 320px", minWidth: 300 }}>
          {isOwner && (
            <form className="card" onSubmit={(e) => void create(e)} style={{ marginBottom: 18 }}>
              <span className="overline">Nouvel article (owner)</span>
              <label>
                <span className="overline">Nom</span>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} required />
              </label>
              <label>
                <span className="overline">Unité (défaut : unité)</span>
                <input value={newUnit} onChange={(e) => setNewUnit(e.target.value)} placeholder="mètre, rouleau…" />
              </label>
              <label>
                <span className="overline">Seuil d&apos;alerte (0 = aucun)</span>
                <input
                  value={newThreshold}
                  onChange={(e) => setNewThreshold(e.target.value)}
                  inputMode="numeric"
                />
              </label>
              <button className="primary" type="submit" disabled={busy || !newName.trim()}>
                Créer
              </button>
            </form>
          )}

          {selected && (
            <div className="card">
              <span className="overline">{selected.name}</span>
              <p className="hint" style={{ margin: "4px 0 10px" }}>
                {selected.quantity} {selected.unit} en stock
                {selected.belowThreshold ? " — sous le seuil !" : ""}
              </p>
              {isOwner && (
                <>
                  <label>
                    <span className="overline">Seuil d&apos;alerte</span>
                    <input
                      value={thresholdDraft}
                      onChange={(e) => setThresholdDraft(e.target.value)}
                      inputMode="numeric"
                    />
                  </label>
                  <label>
                    <span className="overline">Coût de remplacement (€/{selected.unit})</span>
                    <input
                      value={costDraft}
                      onChange={(e) => setCostDraft(e.target.value)}
                      inputMode="decimal"
                      placeholder="1.20"
                    />
                  </label>
                  <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                    <button className="primary" disabled={busy} onClick={() => void saveThreshold()}>
                      Enregistrer
                    </button>
                    <button className="danger" disabled={busy} onClick={() => void remove()}>
                      Supprimer
                    </button>
                  </div>
                </>
              )}
              <hr className="divider" />
              <span className="overline">Derniers mouvements</span>
              {movements === null ? (
                <p className="hint">Chargement…</p>
              ) : movements.length === 0 ? (
                <p className="hint">Aucun mouvement.</p>
              ) : (
                <ul className="hint" style={{ paddingLeft: 18 }}>
                  {movements.map((movement) => (
                    <li key={movement.id}>
                      {new Date(movement.createdAt).toLocaleDateString("fr-FR")} :{" "}
                      {movement.delta > 0 ? `+${movement.delta}` : movement.delta} {selected.unit}
                      {movement.reason ? ` — ${movement.reason}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
      {notice && <p className="error-line">{notice}</p>}
    </>
  );
}
