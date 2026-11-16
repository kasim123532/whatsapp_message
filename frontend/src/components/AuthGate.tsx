import { FormEvent, ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { API_URL, getToken, setToken } from "@/lib/api";
import { Loader2, Lock } from "lucide-react";

/** Matches the server: one login attempt per 3 seconds. */
const COOLDOWN_MS = 3000;

/**
 * Blocks the dashboard behind a password. The token is verified against the
 * server once on load; a 401 anywhere later fires `auth-expired` and lands
 * the user back here.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "locked" | "open">("checking");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const token = getToken();
    fetch(`${API_URL}/auth/check`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setState(d.ok ? "open" : "locked");
      })
      .catch(() => {
        if (!cancelled) {
          setError("Сервер недоступен");
          setState("locked");
        }
      });
    const onExpired = () => setState("locked");
    window.addEventListener("auth-expired", onExpired);
    return () => {
      cancelled = true;
      window.removeEventListener("auth-expired", onExpired);
    };
  }, []);

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [cooldownUntil]);

  const waitMs = Math.max(0, cooldownUntil - now);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || waitMs > 0) return;
    setBusy(true);
    setError(null);
    setCooldownUntil(Date.now() + COOLDOWN_MS);
    setNow(Date.now());
    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Не удалось войти");
        return;
      }
      setToken(data.token);
      setPassword("");
      setState("open");
    } catch {
      setError("Сервер недоступен");
    } finally {
      setBusy(false);
    }
  };

  if (state === "open") return <>{children}</>;
  if (state === "checking") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <form onSubmit={submit} className="w-full max-w-xs space-y-4 text-center">
        <div className="flex items-center justify-center gap-2">
          <Lock className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-display font-bold">Вход</h1>
        </div>
        <Input
          type="password"
          autoFocus
          placeholder="Пароль"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy || waitMs > 0 || !password}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {waitMs > 0 && !busy ? `Подождите ${Math.ceil(waitMs / 1000)} сек` : "Войти"}
        </Button>
      </form>
    </div>
  );
}
