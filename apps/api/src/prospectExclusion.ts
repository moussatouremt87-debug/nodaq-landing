import { createHash } from "node:crypto";

/*
 * Liste d'exclusion de prospection (ticket 2.12, audit RGPD).
 *
 * L'opposition (art. 21) efface l'e-mail et le téléphone de la fiche : c'est
 * la bonne minimisation, mais elle détruit du même geste la seule clé qui
 * permettrait de reconnaître la personne si on la resaisit. Sans liste
 * d'exclusion, la garde annoncée n'existe pas — la même personne est
 * réenregistrée le lendemain et repart en tête des relances.
 *
 * D'où ce module : au moment de l'opposition, on dérive un CONDENSAT des
 * coordonnées avant de les effacer, et la création consulte ces condensats.
 *
 * Ce qu'il ne prétend PAS être : un secret. L'espace des adresses e-mail est
 * énumérable, donc un condensat volé se retrouve par force brute. C'est un
 * verrou anti-réimport — il évite de conserver les coordonnées en clair, il ne
 * transforme pas la donnée en anonyme.
 */

/**
 * Normalise une coordonnée avant condensat : c'est la normalisation qui décide
 * si « Contact@Example.COM » et « contact@example.com » sont la même personne.
 * Volontairement simple et documentée — pas de traitement type « points
 * ignorés chez Gmail », qui varie d'un fournisseur à l'autre et ferait
 * silencieusement diverger deux coordonnées légitimement distinctes.
 */
export function normalizeContact(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return null;
  // Téléphone : seuls les chiffres comptent (espaces, points et indicatif
  // écrits différemment d'une saisie à l'autre).
  if (/^[+\d][\d\s.\-()]*$/.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, "");
    return digits.length >= 6 ? digits : null;
  }
  return trimmed;
}

/**
 * Condensat d'exclusion, SALÉ par le tenant : deux tenants ne peuvent pas
 * rapprocher leurs listes, et une liste exportée ne dit rien de l'autre.
 */
export function contactHash(tenantId: string, value: string): string | null {
  const normalized = normalizeContact(value);
  if (normalized === null) return null;
  return createHash("sha256").update(`${tenantId}:${normalized}`).digest("hex");
}

/** Condensats d'une fiche — e-mail et téléphone, ceux qui sont renseignés. */
export function contactHashes(
  tenantId: string,
  contacts: { email?: string | null | undefined; phone?: string | null | undefined },
): string[] {
  const hashes = new Set<string>();
  for (const value of [contacts.email, contacts.phone]) {
    if (typeof value !== "string") continue;
    const hash = contactHash(tenantId, value);
    if (hash !== null) hashes.add(hash);
  }
  return [...hashes];
}
