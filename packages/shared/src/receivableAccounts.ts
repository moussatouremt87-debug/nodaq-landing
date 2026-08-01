/*
 * Comptes clients et RETENUES DE GARANTIE (ticket 2.20 / US-8).
 *
 * CONFIG VERSIONNÉE DATÉE SOURCÉE (même doctrine que 2.19/3.7/3.9/2.8).
 * Source : plan comptable général (PCG), règlement ANC n° 2014-03 —
 * compte 411 « Clients », subdivision 4117 « Clients — Retenues de garantie ».
 * Consulté le 2026-07-31.
 *
 * POURQUOI CE FICHIER EXISTE
 *
 * Dans le bâtiment, le client retient contractuellement 5 % du montant jusqu'à
 * la levée des réserves — souvent un an après la réception. Ce n'est PAS un
 * impayé : c'est une somme non encore exigible, prévue au marché.
 *
 * La dérivation des créances (2.14) filtrait sur le préfixe `411`, qui inclut
 * `4117`. La retenue était donc agrégée à la facture, la laissait non lettrée,
 * et ressortait en « impayé » — jusqu'à alimenter une proposition de relance.
 *
 * Relancer un bon client sur sa retenue de garantie est la faute qui coûte le
 * plus cher en crédibilité devant un artisan : elle prouve que l'outil ne
 * connaît pas son métier.
 */

/** Bump à chaque modification du rattachement des comptes. */
export const RECEIVABLE_RULES_VERSION = "2026-07-31";

/** Racine des comptes clients. */
export const CUSTOMER_ACCOUNT_PREFIX = "411";

/**
 * Subdivisions portant une RETENUE DE GARANTIE. Le préfixe le plus long
 * l'emporte sur `411` — sinon la retenue redevient une créance ordinaire,
 * ce qui est exactement le défaut corrigé ici.
 */
export const RETENTION_ACCOUNT_PREFIXES = ["4117"] as const;

export type ReceivableKind = "retenue" | "client" | "hors_clients";

/**
 * Nature d'un compte du point de vue des créances clients. PURE.
 *
 * `retenue` et `client` sont deux choses distinctes : la première n'est pas
 * exigible, la seconde l'est. Les confondre fabrique un impayé qui n'existe
 * pas.
 */
export function classifyReceivableAccount(accountNumber: string): ReceivableKind {
  if (RETENTION_ACCOUNT_PREFIXES.some((prefix) => accountNumber.startsWith(prefix))) {
    return "retenue";
  }
  return accountNumber.startsWith(CUSTOMER_ACCOUNT_PREFIX) ? "client" : "hors_clients";
}
