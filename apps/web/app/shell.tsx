"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ApiError, getMe, listPendingActions } from "../lib/api";
import type { Me } from "../lib/api";

/*
 * App shell (UI v2, maquette Figma) : sidebar marine + topbar, gate de
 * session. Business pages need a session AND an active organization (the
 * tenant) — otherwise the user is sent to /login. The shell only ever
 * renders metadata (org name, role, pending COUNT), never business data.
 */

const ICONS: Record<string, ReactNode> = {
  cockpit: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <rect x="1" y="1" width="5.5" height="5.5" rx="1.5" fill="currentColor" />
      <rect x="8.5" y="1" width="5.5" height="5.5" rx="1.5" fill="currentColor" opacity="0.55" />
      <rect x="1" y="8.5" width="5.5" height="5.5" rx="1.5" fill="currentColor" opacity="0.55" />
      <rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1.5" fill="currentColor" />
    </svg>
  ),
  employes: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <circle cx="7.5" cy="4.5" r="3" fill="currentColor" />
      <path d="M1.5 13.5c0-2.8 2.7-4.5 6-4.5s6 1.7 6 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  stocks: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M2 5.5 7.5 2.5 13 5.5v6L7.5 14 2 11.5v-6Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M2 5.5 7.5 8.5 13 5.5M7.5 8.5V14" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  ),
  connecteurs: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path d="M4.5 1.5v4M10.5 1.5v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M2.5 5.5h10v2a5 5 0 0 1-10 0v-2Z" fill="currentColor" />
      <path d="M7.5 12.5v2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  validation: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <rect x="1.5" y="1.5" width="12" height="12" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="m4.6 7.6 2 2 3.8-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  notifications: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path
        d="M7.5 1.5a4 4 0 0 1 4 4c0 2.6.7 3.6 1.3 4.3H2.2c.6-.7 1.3-1.7 1.3-4.3a4 4 0 0 1 4-4Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M6 12.2a1.6 1.6 0 0 0 3 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  classeur: (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path
        d="M1.5 4.5A1.5 1.5 0 0 1 3 3h2.2l1-1.3h2.6l1 1.3H12a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 12 12H3a1.5 1.5 0 0 1-1.5-1.5v-6Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="7.5" cy="7.5" r="2.2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
};

const LINKS = [
  { href: "/", label: "Cockpit", icon: "cockpit" },
  { href: "/chat", label: "Employé Compta", icon: "employes" },
  { href: "/classeur", label: "Classeur", icon: "classeur" },
  { href: "/stocks", label: "Stocks", icon: "stocks" },
  { href: "/immobilisations", label: "Immobilisations", icon: "stocks" },
  { href: "/connecteurs", label: "Connecteurs", icon: "connecteurs" },
  { href: "/validation", label: "File de validation", icon: "validation" },
  { href: "/reglages/notifications", label: "Notifications", icon: "notifications" },
];

const TITLES: Record<string, string> = {
  "/": "Cockpit",
  "/chat": "Employé Compta",
  "/classeur": "Classeur",
  "/stocks": "Stocks",
  "/immobilisations": "Immobilisations",
  "/connecteurs": "Connecteurs",
  "/validation": "File de validation",
  "/reglages/notifications": "Notifications",
  "/ops/support": "Support (back-office)",
};

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const onLogin = pathname === "/login";

  useEffect(() => {
    if (onLogin) return;
    getMe()
      .then((session) => {
        if (!session.activeOrganizationId) router.replace("/login");
        else setMe(session);
      })
      .catch((error: unknown) => {
        // Fail-closed: no confirmed session -> no business page. A 502/503
        // (API down) must not leave the cockpit shell on screen.
        const down = !(error instanceof ApiError) || error.status !== 401;
        router.replace(down ? "/login?service=down" : "/login");
      });
  }, [onLogin, pathname, router]);

  // Badge « N » sur la file de validation — métadonnées seulement (count).
  useEffect(() => {
    if (onLogin || me === null) return;
    listPendingActions()
      .then((actions) => setPendingCount(actions.filter((a) => a.status === "pending").length))
      .catch(() => undefined);
  }, [onLogin, me, pathname]);

  const activeOrg = me?.memberships.find((m) => m.tenantId === me.activeOrganizationId);
  // Fail-closed for real: business pages only mount once the session is
  // confirmed — otherwise they would fire their own API calls in parallel
  // with getMe(), sidebar on screen, while the redirect is still in flight.
  const gated = onLogin || me !== null;

  async function signOut(): Promise<void> {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    router.replace("/login");
  }

  if (onLogin) {
    return <div className="shell bare">{children}</div>;
  }

  const initial = (me?.name ?? activeOrg?.tenant.name ?? "•").trim().charAt(0).toUpperCase();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo" aria-hidden />
          <span className="wordmark">nodaq</span>
          <span className="pill-souverain">Souverain</span>
        </div>
        <nav className="nav">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={pathname === link.href ? "active" : ""}
            >
              {ICONS[link.icon]}
              <span className="nav-label">{link.label}</span>
              {link.href === "/validation" && pendingCount > 0 && (
                <span className="nav-badge">{pendingCount}</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="session">
          {activeOrg ? (
            <>
              <span className="avatar" aria-hidden>
                {initial}
              </span>
              <span className="who">
                <span className="org">{me?.name ?? activeOrg.tenant.name}</span>
                <span className="role">
                  {activeOrg.role === "owner" ? "Dirigeant" : activeOrg.role} ·{" "}
                  {activeOrg.tenant.name}
                </span>
              </span>
              <button onClick={() => void signOut()} title="Se déconnecter">
                Quitter
              </button>
            </>
          ) : (
            <span>—</span>
          )}
        </div>
      </aside>
      <div className="main-col">
        <header className="topbar">
          <span className="topbar-title">{TITLES[pathname] ?? "NODAQ"}</span>
          {activeOrg && (
            <span className="org-chip">
              <span className="dot" aria-hidden />
              {activeOrg.tenant.name}
            </span>
          )}
        </header>
        <main className="content">
          {gated ? children : <p className="empty">Vérification de la session…</p>}
        </main>
      </div>
    </div>
  );
}
