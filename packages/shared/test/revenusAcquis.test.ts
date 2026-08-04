import { describe, expect, it } from "vitest";
import { REVENUS_VERSION, splitRevenus } from "../src/index.js";

/*
 * Encaissé ≠ acquis (4.2, bloc 3).
 *
 * LA CONFUSION QUE CE MOTEUR EXISTE POUR RENDRE IMPOSSIBLE : un acompte
 * encaissé n'est pas du travail livré, et un devis signé n'est pas non plus du
 * travail livré. Les trois chiffres ne se mélangent jamais — et surtout, celui
 * qui rentre (du TTC) ne se compare jamais à celui qui est gagné (du HT).
 *
 * Le bloc 2 a rendu la faute facile : matérialiser douze passages d'un contrat
 * crée douze affaires devisées d'un coup. Sommées naïvement, elles font une
 * année de chiffre « gagné » le jour du clic.
 */

const AFFAIRE = {
  status: "TERMINEE" as const,
  quotedAmountCents: 100_000,
  depositsCents: 0,
  completedAt: null as string | null,
};

describe("config versionnée datée", () => {
  it("porte une version datée", () => {
    expect(REVENUS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
  });
});

describe("acquis = travail LIVRÉ, jamais travail vendu", () => {
  it("une affaire terminée est acquise", () => {
    const res = splitRevenus([AFFAIRE], null);
    expect(res.acquisCents).toBe(100_000);
    expect(res.engageCents).toBe(0);
  });

  it("une affaire acceptée ou en cours est ENGAGÉE, pas acquise", () => {
    /*
     * C'est LE piège du bloc 2. Douze interventions matérialisées d'avance sont
     * douze devis signés, pas douze chantiers faits. Les compter en acquis
     * ferait apparaître une année de chiffre d'affaires le jour du clic — et
     * une marge globale flatteuse sur du travail qui n'a pas commencé.
     */
    const res = splitRevenus([
      { ...AFFAIRE, status: "ACCEPTEE" },
      { ...AFFAIRE, status: "EN_COURS" },
    ], null);
    expect(res.acquisCents).toBe(0);
    expect(res.engageCents).toBe(200_000);
  });

  it("un devis envoyé ou un prospect n'est NI acquis NI engagé", () => {
    // Rien n'est signé : le compter en engagé, c'est compter sur un client qui
    // n'a pas dit oui.
    const res = splitRevenus([
      { ...AFFAIRE, status: "PROSPECT" },
      { ...AFFAIRE, status: "DEVIS_ENVOYE" },
    ], null);
    expect(res.acquisCents).toBe(0);
    expect(res.engageCents).toBe(0);
  });

  it("un acompte sur une affaire PERDUE reste encaissé", () => {
    // « Ce que j'ai » ≠ « ce que j'ai gagné » : l'acompte non remboursé d'une
    // affaire abandonnée est toujours sur le compte.
    const res = splitRevenus([{ ...AFFAIRE, status: "PERDUE", depositsCents: 15_000 }], null);
    expect(res.encaisseDeclareCents).toBe(15_000);
    expect(res.acquisCents).toBe(0);
  });

  it("une affaire PERDUE ne compte nulle part", () => {
    const res = splitRevenus([{ ...AFFAIRE, status: "PERDUE" }], null);
    expect(res.acquisCents).toBe(0);
    expect(res.engageCents).toBe(0);
  });

  it("une ARCHIVÉE sans preuve de livraison ne compte nulle part", () => {
    /*
     * Ranger n'est pas livrer. `ARCHIVEE` est la sortie commune des affaires
     * gagnées ET perdues : le statut seul ne dit plus laquelle. Sans un FAIT
     * qui atteste la livraison, elle reste hors de l'acquis — c'est
     * `completedAt` qui tranche, et lui seul (voir plus bas).
     */
    const rangee = splitRevenus([{ ...AFFAIRE, status: "ARCHIVEE" }], null);
    expect(rangee.acquisCents).toBe(0);
    expect(rangee.engageCents).toBe(0);
  });
});

describe("encaissé = de l'argent SUR LE COMPTE, et c'est du TTC", () => {
  it("acomptes DÉCLARÉS et factures RÉGLÉES ne sont jamais additionnés", () => {
    /*
     * Le double comptage que ce découpage interdit : dans le bâtiment, une
     * facture d'acompte est À LA FOIS une pièce du FEC réglée à 100 % et un
     * acompte que le dirigeant déclare sur la fiche. Les sommer ferait 7 200 €
     * là où 3 600 € sont rentrés — dans la direction flatteuse.
     *
     * Rien ne permet de les rapprocher : une déclaration d'acompte ne porte
     * aucun lien vers la pièce comptable. On refuse donc de sommer.
     */
    const res = splitRevenus([{ ...AFFAIRE, depositsCents: 360_000 }], 360_000);
    expect(res.encaisseDeclareCents).toBe(360_000);
    expect(res.encaisseFactureCents).toBe(360_000);
    expect(Object.keys(res)).not.toContain("encaisseCents");
  });

  it("les acomptes sont encaissés, jamais acquis", () => {
    /*
     * Un acompte de 30 % sur un chantier qui n'a pas commencé, c'est de la
     * trésorerie — pas du résultat. Beaucoup de TPE se croient rentables en
     * regardant leur solde bancaire : c'est exactement l'erreur que ce
     * découpage rend impossible à commettre dans le produit.
     */
    const res = splitRevenus([
      { ...AFFAIRE, status: "EN_COURS", depositsCents: 30_000 },
    ], null);
    expect(res.encaisseDeclareCents).toBe(30_000);
    expect(res.acquisCents).toBe(0);
    expect(res.engageCents).toBe(100_000);
  });

  it("le RÉGLÉ des factures est rendu, à part", () => {
    const res = splitRevenus([AFFAIRE], 50_000);
    expect(res.encaisseFactureCents).toBe(50_000);
  });

  it("encaissé et acquis ne sont JAMAIS soustraits l'un de l'autre", () => {
    /*
     * L'encaissé est du TTC (ce que le client a viré), l'acquis est du HT (ce
     * que vaut le travail). Leur différence n'a aucun sens : elle vaudrait
     * environ la TVA, qui n'appartient pas à l'entreprise. Le moteur rend donc
     * les DEUX bases, et aucun écart.
     */
    const res = splitRevenus([AFFAIRE], null);
    expect(res.acquisBasis).toBe("ht");
    expect(res.encaisseBasis).toBe("ttc");
    expect(Object.keys(res)).not.toContain("ecartCents");
    expect(Object.keys(res)).not.toContain("resteAEncaisserCents");
  });
});

describe("ce qui n'est pas calculé est DIT", () => {
  it("une affaire SANS devis est comptée et nommée, jamais ignorée en silence", () => {
    /*
     * Sans devis, la valeur du travail est inconnue. La compter zéro ferait un
     * chiffre d'affaires acquis sous-estimé présenté comme exact — et
     * personne ne saurait de combien il manque.
     */
    const res = splitRevenus([
      { ...AFFAIRE, quotedAmountCents: null },
      { ...AFFAIRE, status: "EN_COURS", quotedAmountCents: null },
    ], null);
    expect(res.acquisCents).toBe(0);
    expect(res.sansDevis).toBe(2);
    expect(res.exact).toBe(false);
  });

  it("tout devisé et rien d'inconnu ⇒ le résultat se dit EXACT", () => {
    const res = splitRevenus([AFFAIRE, { ...AFFAIRE, status: "EN_COURS" }], null);
    expect(res.sansDevis).toBe(0);
    expect(res.exact).toBe(true);
  });

  it("une facture TTC ne contamine pas l'acquis HT", () => {
    // L'acquis vient du DEVIS (HT). Le réglé des factures est du TTC et vit
    // dans son propre chiffre : jamais fondu dans le même total.
    const res = splitRevenus([AFFAIRE], 120_000);
    expect(res.acquisCents).toBe(100_000);
    expect(res.encaisseFactureCents).toBe(120_000);
  });

  it("une liste vide rend des zéros EXACTS, pas une absence", () => {
    // Zéro affaire, c'est une réponse : « rien », pas « on ne sait pas ».
    const res = splitRevenus([], null);
    expect(res.acquisCents).toBe(0);
    expect(res.engageCents).toBe(0);
    expect(res.encaisseDeclareCents).toBe(0);
    // `null`, pas zéro : sans source comptable, « 0 € réglé » se lirait
    // « rien n'est rentré ».
    expect(res.encaisseFactureCents).toBeNull();
    expect(res.exact).toBe(true);
  });
});

/*
 * `completedAt` — un FAIT remplace une déduction.
 *
 * Le bloc 3 sortait toute affaire `ARCHIVEE` de l'acquis, y compris celles qui
 * avaient été terminées : `status` est une colonne unique, donc ranger écrase
 * `TERMINEE`. Le chiffre d'un exercice baissait quand le patron rangeait.
 *
 * Le rattrapage par `actualEndDate` avait été implémenté puis RETIRÉ : champ
 * libre, et `POST /affaires/:id/archiver` accepte n'importe quel statut de
 * départ — une affaire abandonnée dont quelqu'un avait saisi la date d'arrêt
 * aurait compté à 100 % du devis. Sur-estimation invisible et flatteuse.
 *
 * `completedAt` n'est pas une déduction : il est posé au MOMENT de la
 * transition vers `TERMINEE`, et rien d'autre ne l'écrit. Une affaire jamais
 * terminée ne peut pas en avoir un.
 */
describe("archiver ne défait plus ce qui a été livré", () => {
  it("une ARCHIVÉE qui a été TERMINÉE compte en acquis", () => {
    const res = splitRevenus(
      [{ ...AFFAIRE, status: "ARCHIVEE", completedAt: "2026-03-14T10:00:00.000Z" }],
      null,
    );
    expect(res.acquisCents).toBe(100_000);
    expect(res.engageCents).toBe(0);
  });

  it("une ARCHIVÉE JAMAIS terminée ne compte nulle part", () => {
    /*
     * Le cas que `actualEndDate` ratait. Une affaire PERDUE puis archivée n'a
     * aucun `completedAt` — aucune transition vers `TERMINEE` n'a eu lieu —
     * donc elle reste hors de l'acquis quoi qu'on ait saisi ailleurs.
     */
    const res = splitRevenus([{ ...AFFAIRE, status: "ARCHIVEE", completedAt: null }], null);
    expect(res.acquisCents).toBe(0);
    expect(res.engageCents).toBe(0);
  });

  it("`completedAt` ne rattrape QUE l'archivage, jamais un statut vivant", () => {
    /*
     * Une affaire terminée puis REPRISE (`TERMINEE -> EN_COURS`) est du travail
     * en cours, pas du travail livré. Si `completedAt` suffisait à lui seul, une
     * reprise resterait comptée en acquis — et l'affaire compterait DEUX fois
     * le jour où elle se terminerait à nouveau. C'est le statut qui décide ;
     * `completedAt` ne fait que rendre `ARCHIVEE` lisible.
     */
    const res = splitRevenus(
      [{ ...AFFAIRE, status: "EN_COURS", completedAt: "2026-03-14T10:00:00.000Z" }],
      null,
    );
    expect(res.acquisCents).toBe(0);
    expect(res.engageCents).toBe(100_000);
  });

  it("une ARCHIVÉE terminée SANS devis est comptée à part, pas ignorée", () => {
    // Même règle que partout : la valeur du travail est inconnue, donc l'acquis
    // ne peut pas se dire exact.
    const res = splitRevenus(
      [
        {
          ...AFFAIRE,
          status: "ARCHIVEE",
          quotedAmountCents: null,
          completedAt: "2026-03-14T10:00:00.000Z",
        },
      ],
      null,
    );
    expect(res.acquisCents).toBe(0);
    expect(res.sansDevis).toBe(1);
    expect(res.exact).toBe(false);
  });

  it("une PERDUE avec un `completedAt` reste hors de l'acquis", () => {
    /*
     * `TERMINEE -> PERDUE` est une correction : le chantier n'a finalement pas
     * eu lieu. La route efface `completedAt` sur cette transition, mais le
     * moteur ne s'y fie pas — il ne rattrape que `ARCHIVEE`. Deux gardes
     * plutôt qu'une, parce qu'une seule suffirait à rendre un chiffre flatteur
     * si l'autre cédait.
     */
    const res = splitRevenus(
      [{ ...AFFAIRE, status: "PERDUE", completedAt: "2026-03-14T10:00:00.000Z" }],
      null,
    );
    expect(res.acquisCents).toBe(0);
    expect(res.engageCents).toBe(0);
  });
});
