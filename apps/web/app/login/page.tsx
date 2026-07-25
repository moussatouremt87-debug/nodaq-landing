"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

/*
 * Sign-in / sign-up / organization bootstrap against better-auth REST
 * endpoints (same-origin proxy). Signing up auto-signs in; creating an
 * organization makes it the session's active tenant (server-side hook).
 */

type Mode = "signin" | "signup";

async function authPost(path: string, payload: object): Promise<Response> {
  return fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "org"
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const auth =
        mode === "signin"
          ? await authPost("sign-in/email", { email, password })
          : await authPost("sign-up/email", { email, password, name });
      if (!auth.ok) {
        // One generic message for both flows: no user enumeration.
        setError(
          mode === "signin"
            ? "Connexion refusée : vérifiez vos identifiants."
            : "Inscription impossible avec ces informations.",
        );
        return;
      }
      if (mode === "signup" && orgName) {
        const org = await authPost("organization/create", {
          name: orgName,
          slug: slugify(orgName),
        });
        if (!org.ok) {
          setError("Compte créé, mais la création de l'organisation a échoué.");
          return;
        }
      }
      router.replace("/");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="page-title">{mode === "signin" ? "Connexion" : "Créer un compte"}</h1>
      <p className="page-sub">
        {mode === "signin"
          ? "Reprenez la main sur votre cockpit."
          : "Votre organisation devient votre espace isolé (tenant)."}
      </p>
      <form className="form-card" onSubmit={(e) => void submit(e)}>
        {mode === "signup" && (
          <label>
            <span className="overline">Nom</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
        )}
        <label>
          <span className="overline">E-mail</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </label>
        <label>
          <span className="overline">Mot de passe</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
          />
        </label>
        {mode === "signup" && (
          <label>
            <span className="overline">Organisation (votre entreprise)</span>
            <input
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Ex. Menuiserie Dupont"
              required
            />
          </label>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {mode === "signin" ? "Se connecter" : "Créer le compte"}
        </button>
        {error && <p className="error-line">{error}</p>}
        <p className="hint" style={{ marginTop: 18 }}>
          {mode === "signin" ? (
            <button type="button" onClick={() => setMode("signup")}>
              Première visite ? Créer un compte
            </button>
          ) : (
            <button type="button" onClick={() => setMode("signin")}>
              Déjà inscrit ? Se connecter
            </button>
          )}
        </p>
      </form>
    </>
  );
}
