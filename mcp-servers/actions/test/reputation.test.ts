import { describe, expect, it } from "vitest";
import { analyzeReputation } from "../src/reputation.js";

/*
 * E-réputation (ticket 3.8) — modèle PUR, déterministe, explicable : note
 * moyenne, répartition, tendance sur la fenêtre, avis négatifs récents sans
 * réponse (alerte). Aucun nom d'auteur (PII) ne sort du modèle : uniquement
 * des agrégats et des ids d'avis.
 */

const NOW = new Date("2026-07-30T12:00:00Z");

function review(
  id: string,
  rating: number,
  reviewedAt: string,
  replied = false,
): {
  id: string;
  rating: number;
  reviewedAt: string;
  replyText: string | null;
} {
  return { id, rating, reviewedAt, replyText: replied ? "Merci !" : null };
}

describe("analyzeReputation", () => {
  it("note moyenne, répartition et taux de réponse chiffrés", () => {
    const report = analyzeReputation(
      [
        review("r1", 5, "2026-07-01", true),
        review("r2", 4, "2026-06-15"),
        review("r3", 1, "2026-07-20"),
      ],
      NOW,
    );
    expect(report.totalReviews).toBe(3);
    expect(report.averageRating).toBeCloseTo(3.33, 1);
    expect(report.distribution).toMatchObject({ "5": 1, "4": 1, "1": 1 });
    expect(report.replyRatePct).toBe(33); // 1 réponse sur 3
    expect(report.label).toContain("avis enregistrés");
  });

  it("alerte : avis récents (≤ 30 j) notés ≤ 2 sans réponse, ids remontés jamais les noms", () => {
    const report = analyzeReputation(
      [
        review("bad-recent", 1, "2026-07-25"),
        review("bad-replied", 2, "2026-07-22", true),
        review("bad-old", 1, "2026-01-05"),
        review("good", 5, "2026-07-28"),
      ],
      NOW,
    );
    expect(report.unansweredNegative.map((a) => a.id)).toEqual(["bad-recent"]);
    expect(report.unansweredNegative[0]?.daysAgo).toBe(5);
    expect(JSON.stringify(report)).not.toContain("authorName");
  });

  it("tendance : moyenne 6 derniers mois vs 6 précédents, verdict chiffré", () => {
    const reviews = [
      // Ancien semestre : 2 et 5 (moyenne 3,5) ; récent : 5 et 5 (moyenne 5).
      review("o1", 2, "2025-09-10"),
      review("o2", 5, "2025-11-02"),
      review("n1", 5, "2026-06-01"),
      review("n2", 5, "2026-07-10"),
    ];
    const report = analyzeReputation(reviews, NOW);
    expect(report.trend?.recentAverage).toBe(5);
    expect(report.trend?.previousAverage).toBe(3.5);
    expect(report.trend?.verdict).toBe("en_hausse");
    // Pas assez d'avis anciens -> pas de tendance fabriquée.
    const flat = analyzeReputation([review("only", 4, "2026-07-01")], NOW);
    expect(flat.trend).toBeNull();
  });

  it("zéro avis : rapport vide honnête, jamais une moyenne fabriquée", () => {
    const report = analyzeReputation([], NOW);
    expect(report.totalReviews).toBe(0);
    expect(report.averageRating).toBeNull();
    expect(report.trend).toBeNull();
    expect(report.unansweredNegative).toEqual([]);
  });

  it("lignes invalides (note hors 1..5, date illisible) filtrées, jamais une exception", () => {
    const report = analyzeReputation(
      [
        review("ok", 4, "2026-07-01"),
        review("bad-rating", 9, "2026-07-02"),
        review("bad-date", 3, "n'importe quoi"),
        "garbage" as never,
      ],
      NOW,
    );
    expect(report.totalReviews).toBe(1);
    expect(report.averageRating).toBe(4);
  });
});
