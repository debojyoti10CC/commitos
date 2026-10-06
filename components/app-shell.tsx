"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useApp } from "./app-provider";
import { Button } from "./ui";

const navigation = [
  { href: "/dashboard", label: "Records" },
  { href: "/commitments", label: "Dates" },
  { href: "/projects", label: "Collections" },
  { href: "/people", label: "People" },
  { href: "/settings", label: "Settings" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { loading, error, mode, refresh } = useApp();
  const path = usePathname();
  return (
    <div className="retro-desktop">
      <div className="retro-app">
        <header className="retro-app-title">
          <strong>CommitOS</strong>
        </header>
        <nav className="retro-menu" aria-label="Main navigation">
          {navigation.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              aria-current={path === href ? "page" : undefined}
            >
              {label}
            </Link>
          ))}
        </nav>
        <main className="retro-app-content">
          {loading ? (
            <p role="status" className="retro-loading">
              Loading records…
            </p>
          ) : error ? (
            <div className="retro-error" role="alert">
              <h1>Could not load records</h1>
              <p>{error}</p>
              <Button onClick={() => void refresh()}>Retry</Button>
            </div>
          ) : (
            children
          )}
        </main>
        <footer className="retro-status">
          {mode === "demo"
            ? "Stored on this computer"
            : "Stored in your account"}
        </footer>
      </div>
    </div>
  );
}
