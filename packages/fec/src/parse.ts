import { z } from "zod";

/*
 * Parseur FEC — Fichier des Écritures Comptables (art. A47 A-1 du LPF,
 * arrêté du 29 juillet 2013). Spécification encodée ici (les portails
 * officiels — Légifrance, BOFiP — sont consultés hors bande ; la structure
 * est stable depuis 2013) :
 *
 * - Fichier à plat, 1re ligne = en-têtes. 18 colonnes dans l'ordre :
 *   JournalCode | JournalLib | EcritureNum | EcritureDate | CompteNum |
 *   CompteLib | CompAuxNum | CompAuxLib | PieceRef | PieceDate |
 *   EcritureLib | Debit | Credit | EcritureLet | DateLet | ValidDate |
 *   Montantdevise | Idevise
 *   Variante BNC (comptabilité recettes-dépenses) : Debit/Credit remplacés
 *   par Montant + Sens (D/C). Certains éditeurs accentuent (« Débit ») ou
 *   ajoutent des colonnes finales : tolérées, signalées en avertissement.
 * - Séparateur : tabulation OU barre verticale « | ».
 * - Dates : AAAAMMJJ. Montants : séparateur décimal virgule (le point est
 *   toléré — déviation éditeur fréquente), 2 décimales max -> CENTIMES
 *   entiers, jamais de flottant.
 * - Encodage : ISO 8859-15 selon l'arrêté ; l'UTF-8 est répandu chez les
 *   éditeurs -> détection (UTF-8 strict d'abord, repli ISO-8859-15).
 * - Cohérence : total Débit = total Crédit, sinon rejet FRANC (jamais
 *   d'ingestion partielle).
 *
 * IMPORTANT (confidentialité) : les messages d'erreur ne citent JAMAIS le
 * contenu d'une ligne — uniquement des numéros de ligne et de colonne.
 */

export interface FecEntry {
  /** Numéro de ligne dans le fichier (1 = en-tête). */
  line: number;
  journalCode: string;
  journalLib: string;
  ecritureNum: string;
  /** ISO yyyy-mm-dd. */
  ecritureDate: string;
  compteNum: string;
  compteLib: string;
  compAuxNum: string | null;
  compAuxLib: string | null;
  pieceRef: string | null;
  pieceDate: string | null;
  ecritureLib: string;
  debitCents: number;
  creditCents: number;
  ecritureLet: string | null;
  dateLet: string | null;
  validDate: string | null;
}

export interface FecLineError {
  line: number;
  message: string;
}

export interface FecParseOk {
  ok: true;
  entries: FecEntry[];
  separator: "tab" | "pipe";
  encoding: "utf-8" | "iso-8859-15";
  variant: "debit-credit" | "montant-sens";
  totalDebitCents: number;
  totalCreditCents: number;
  warnings: string[];
}

export interface FecParseFail {
  ok: false;
  errors: FecLineError[];
}

export type FecParseResult = FecParseOk | FecParseFail;

/** Plafond d'erreurs détaillées dans le rapport (le rejet reste total). */
const MAX_ERRORS = 50;

/** Plafond de lignes : borne le coût CPU/mémoire d'un parse (l'event loop
 * n'est pas cédé pendant l'analyse — un fichier hors gabarit est rejeté
 * AVANT tout travail lourd). */
const MAX_LINES = 500_000;

const CANONICAL_HEADER = [
  "journalcode",
  "journallib",
  "ecriturenum",
  "ecrituredate",
  "comptenum",
  "comptelib",
  "compauxnum",
  "compauxlib",
  "pieceref",
  "piecedate",
  "ecriturelib",
  "debit",
  "credit",
  "ecriturelet",
  "datelet",
  "validdate",
  "montantdevise",
  "idevise",
] as const;

const BNC_HEADER = [...CANONICAL_HEADER.slice(0, 11), "montant", "sens", ...CANONICAL_HEADER.slice(13)];

/** Normalise un nom d'en-tête : accents retirés, casse ignorée. */
function normalizeHeader(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/gi, "")
    .toLowerCase();
}

function decode(input: Uint8Array): { text: string; encoding: "utf-8" | "iso-8859-15" } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(input), encoding: "utf-8" };
  } catch {
    // ISO-8859-15 (arrêté) — repli latin1 si le runtime ne connaît pas le label.
    try {
      return {
        text: new TextDecoder("iso-8859-15").decode(input),
        encoding: "iso-8859-15",
      };
    } catch {
      return { text: new TextDecoder("latin1").decode(input), encoding: "iso-8859-15" };
    }
  }
}

const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;

/** AAAAMMJJ -> ISO, null si invalide. */
function parseFecDate(raw: string): string | null {
  const match = DATE_RE.exec(raw);
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${y}-${m}-${d}`;
}

const AMOUNT_RE = /^-?\d+(?:[.,]\d{1,2})?$/;

/**
 * Montant FEC -> centimes ENTIERS, par manipulation de chaîne (aucun float).
 * Tolère les espaces (dont insécables) comme séparateurs de milliers.
 */
export function amountToCents(raw: string): number | null {
  const cleaned = raw.replace(/[\s\u00A0\u202F]/g, "");
  if (cleaned === "") return 0;
  if (!AMOUNT_RE.test(cleaned)) return null;
  const negative = cleaned.startsWith("-");
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [intPart, fracPart = ""] = unsigned.split(/[.,]/);
  const cents = Number(intPart) * 100 + Number(fracPart.padEnd(2, "0") || "0");
  return negative ? -cents : cents;
}

const RowSchema = z.object({
  journalCode: z.string().min(1),
  journalLib: z.string(),
  ecritureNum: z.string().min(1),
  ecritureDate: z.string().min(1),
  compteNum: z.string().min(1),
  compteLib: z.string(),
  ecritureLib: z.string(),
});

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function parseFec(input: Uint8Array | string): FecParseResult {
  const { text, encoding } =
    typeof input === "string" ? { text: input, encoding: "utf-8" as const } : decode(input);

  // BOM éventuel + lignes ; les lignes vides de fin sont ignorées.
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.length < 2) {
    return { ok: false, errors: [{ line: 1, message: "fichier vide ou sans écritures" }] };
  }
  if (lines.length - 1 > MAX_LINES) {
    return {
      ok: false,
      errors: [{ line: 0, message: `fichier trop volumineux (${MAX_LINES} écritures max)` }],
    };
  }

  const headerLine = lines[0]!;
  const separator: "tab" | "pipe" | null = headerLine.includes("\t")
    ? "tab"
    : headerLine.includes("|")
      ? "pipe"
      : null;
  if (!separator) {
    return {
      ok: false,
      errors: [{ line: 1, message: "séparateur non reconnu (tabulation ou « | » attendus)" }],
    };
  }
  const sep = separator === "tab" ? "\t" : "|";

  const header = headerLine.split(sep).map(normalizeHeader);
  const warnings: string[] = [];

  const matches = (expected: readonly string[]) =>
    expected.every((name, index) => header[index] === name);
  let variant: "debit-credit" | "montant-sens";
  if (matches(CANONICAL_HEADER)) {
    variant = "debit-credit";
  } else if (matches(BNC_HEADER)) {
    variant = "montant-sens";
  } else {
    return {
      ok: false,
      errors: [
        {
          line: 1,
          message:
            "en-tête non conforme A47 A-1 (18 colonnes JournalCode…Idevise, ou variante Montant/Sens)",
        },
      ],
    };
  }
  if (header.length > 18) {
    warnings.push(`${header.length - 18} colonne(s) supplémentaire(s) ignorée(s) après Idevise`);
  }

  const errors: FecLineError[] = [];
  const entries: FecEntry[] = [];
  let totalDebitCents = 0;
  let totalCreditCents = 0;

  for (let i = 1; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i]!;
    if (raw.trim() === "") continue;
    const cols = raw.split(sep);
    if (cols.length < 18) {
      errors.push({ line: lineNo, message: `ligne incomplète (${cols.length} colonnes sur 18)` });
      continue;
    }

    const ecritureDate = parseFecDate(cols[3]!.trim());
    if (!ecritureDate) {
      errors.push({ line: lineNo, message: "EcritureDate invalide (AAAAMMJJ attendu)" });
      continue;
    }
    const pieceDateRaw = cols[9]!.trim();
    const pieceDate = pieceDateRaw === "" ? null : parseFecDate(pieceDateRaw);
    if (pieceDateRaw !== "" && !pieceDate) {
      errors.push({ line: lineNo, message: "PieceDate invalide (AAAAMMJJ attendu)" });
      continue;
    }
    const dateLetRaw = cols[14]!.trim();
    const dateLet = dateLetRaw === "" ? null : parseFecDate(dateLetRaw);
    const validDateRaw = cols[15]!.trim();
    const validDate = validDateRaw === "" ? null : parseFecDate(validDateRaw);

    let debitCents: number | null;
    let creditCents: number | null;
    if (variant === "debit-credit") {
      debitCents = amountToCents(cols[11]!);
      creditCents = amountToCents(cols[12]!);
      if (debitCents === null || creditCents === null) {
        errors.push({ line: lineNo, message: "montant Débit/Crédit invalide" });
        continue;
      }
    } else {
      const montant = amountToCents(cols[11]!);
      const sens = cols[12]!.trim().toUpperCase();
      if (montant === null || (sens !== "D" && sens !== "C")) {
        errors.push({ line: lineNo, message: "Montant/Sens invalide (Sens = D ou C)" });
        continue;
      }
      debitCents = sens === "D" ? montant : 0;
      creditCents = sens === "C" ? montant : 0;
    }

    const parsed = RowSchema.safeParse({
      journalCode: cols[0]!.trim(),
      journalLib: cols[1]!.trim(),
      ecritureNum: cols[2]!.trim(),
      ecritureDate,
      compteNum: cols[4]!.trim(),
      compteLib: cols[5]!.trim(),
      ecritureLib: cols[10]!.trim(),
    });
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join(".") ?? "colonne";
      errors.push({ line: lineNo, message: `champ obligatoire manquant (${field})` });
      continue;
    }

    totalDebitCents += debitCents;
    totalCreditCents += creditCents;
    entries.push({
      line: lineNo,
      ...parsed.data,
      compAuxNum: emptyToNull(cols[6]!),
      compAuxLib: emptyToNull(cols[7]!),
      pieceRef: emptyToNull(cols[8]!),
      pieceDate,
      debitCents,
      creditCents,
      ecritureLet: emptyToNull(cols[13]!),
      dateLet,
      validDate,
    });

    if (errors.length >= MAX_ERRORS) break;
  }

  if (errors.length > 0) {
    return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  }
  if (entries.length === 0) {
    return { ok: false, errors: [{ line: 2, message: "aucune écriture exploitable" }] };
  }
  if (totalDebitCents !== totalCreditCents) {
    return {
      ok: false,
      errors: [
        {
          line: 0,
          message: `déséquilibre débit/crédit (écart de ${Math.abs(totalDebitCents - totalCreditCents)} centimes) — fichier rejeté`,
        },
      ],
    };
  }

  return {
    ok: true,
    entries,
    separator,
    encoding,
    variant,
    totalDebitCents,
    totalCreditCents,
    warnings,
  };
}
