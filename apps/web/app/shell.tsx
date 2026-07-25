"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ApiError, getMe } from "../lib/api";
import type { Me } from "../lib/api";

/*
 * App shell: sidebar + session gate. Business pages need a session AND an
 * active organization (the tenant) — otherwise the user is sent to /login.
 * The shell only ever renders metadata (org name, role), never business data.
 */

const LINKS = [
  { href: "/", label: "Cockpit" },
  { href: "/validation", label: "File de validation" },
  { href: "/chat", label: "Employé Compta" },
];

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const onLogin = pathname === "/login";

  useEffect(() => {
    if (onLogin) return;
    getMe()
      .then((session) => {
        if (!session.activeOrganizationId) router.replace("/login");
        else setMe(session);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) router.replace("/login");
      });
  }, [onLogin, pathname, router]);

  const activeOrg = me?.memberships.find((m) => m.tenantId === me.activeOrganizationId);

  async function signOut(): Promise<void> {
    await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    router.replace("/login");
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          NODAQ
          <small>Employés virtuels souverains</small>
        </div>
        <nav className="nav">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={pathname === link.href ? "active" : ""}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="session">
          {activeOrg ? (
            <>
              <div>{activeOrg.tenant.name}</div>
              <div className="overline">{activeOrg.role}</div>
              <button onClick={() => void signOut()}>Se déconnecter</button>
            </>
          ) : (
            <span>—</span>
          )}
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
