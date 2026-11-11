"use client";

import { useState } from "react";

export function OfficeLoginForm({ redirectTo }: { redirectTo?: string }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/office-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 401 ? "Incorrect password" : "Login failed");
        setBusy(false);
        return;
      }
      window.location.href = redirectTo ?? payload.redirectTo ?? "/dashboard";
    } catch {
      setError("Login failed");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-2">
        <label
          htmlFor="office-code"
          className="block text-sm font-medium text-foreground"
        >
          Password
        </label>
        <input
          id="office-code"
          type="password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          autoFocus
          autoComplete="current-password"
          className="w-full px-4 py-3 rounded bg-surface border border-border text-sm text-foreground focus:border-accent/40 focus:outline-none"
        />
      </div>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <button
        type="submit"
        disabled={busy}
        className="w-full inline-flex items-center justify-center rounded bg-accent px-6 py-3.5 text-sm font-semibold text-white disabled:opacity-60"
      >
        {busy ? "Signing in…" : "Enter Rahbin"}
      </button>
    </form>
  );
}
