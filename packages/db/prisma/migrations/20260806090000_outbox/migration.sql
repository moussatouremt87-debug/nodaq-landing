-- Bus d'événements (ticket 4.4, PR A) — la table OUTBOX.
--
-- POURQUOI UN OUTBOX ET PAS UN `emit()` APRÈS LE COMMIT. Un `await commit()`
-- suivi d'un `emit()` a deux défauts symétriques et tous deux silencieux :
-- un crash entre les deux PERD l'événement (l'écriture a eu lieu, personne ne
-- le saura), et un `emit()` placé avant le commit en PRODUIT pour des
-- transactions annulées (une relance déclenchée par un travail qui n'a jamais
-- été enregistré). Insérer l'événement DANS la transaction métier rend les
-- deux impossibles par construction : il est là si et seulement si l'écriture
-- a été validée.
--
-- AUCUNE DONNÉE MÉTIER. L'événement porte de quoi RELIRE, jamais de quoi lire :
-- type, objet visé, champs changés. Un montant ou un nom déposé ici finirait
-- dans les files, les journaux et les rejeux — et serait périmé au moment où
-- quelqu'un le lit. Le consommateur relit la donnée sous `withTenant`.
--
-- `delivered_at` NULL = à relayer. Le relais le pose ; un rejeu se contente
-- donc de reprendre là où il en était, et un consommateur idempotent ne
-- produit rien deux fois.

CREATE TABLE "outbox" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"      UUID NOT NULL,
  -- Type d'événement de domaine — valeurs du registre partagé.
  "type"           TEXT NOT NULL,
  -- Nature de l'objet touché ('affaire', 'pending_action'…). Jamais son contenu.
  "object_type"    TEXT NOT NULL,
  -- Identifiant de l'objet touché. Opaque, jamais un libellé.
  "object_id"      TEXT,
  -- Noms des champs modifiés — des NOMS, jamais des valeurs.
  "changed_fields" TEXT[] NOT NULL DEFAULT '{}',
  "occurred_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Corrèle les événements d'une même requête, pour le rejeu et le débogage.
  "correlation_id" TEXT,
  "delivered_at"   TIMESTAMP(3),
  CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "outbox" ADD CONSTRAINT "outbox_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Index du RELAIS : il ne lit que ce qui n'est pas encore transmis, dans
-- l'ordre d'arrivée. Partiel, parce que la partie transmise grossit sans fin
-- et n'est jamais lue par ce chemin — un index plein la trierait pour rien.
CREATE INDEX "outbox_undelivered_idx"
  ON "outbox"("tenant_id", "occurred_at")
  WHERE "delivered_at" IS NULL;

-- RLS (règle n°6 du CLAUDE.md) : toute table métier ⇒ tenant_id + policy +
-- test d'isolation qui échoue si on retire la policy.
ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "outbox"
  USING ("tenant_id" = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant_id', true)::uuid);
