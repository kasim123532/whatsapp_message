import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { apiRequest } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, MessageCircle, RefreshCw, AlertTriangle } from "lucide-react";

interface AccountStatus {
  id: string;
  phone: string | null;
  name: string | null;
  status: "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "BANNED";
  qr: string | null;
  qrExpiresAt: number | null;
  running: boolean;
}

function formatCountdown(msLeft: number) {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const ConnectAccount = () => {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<AccountStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const startedRef = useRef(false);

  const poll = useCallback(async () => {
    if (!id) return null;
    const res: AccountStatus = await apiRequest(`/accounts/${id}/status`);
    setData(res);
    setError(null);
    return res;
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await poll();
        if (cancelled || !res) return;
        // Kick off the very first handshake for a link that was just opened.
        if (!startedRef.current && res.status === "DISCONNECTED" && !res.running) {
          startedRef.current = true;
          apiRequest(`/accounts/${id}/connect`, { method: "POST" }).catch(() => {});
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message || "Ссылка недействительна");
      }
    };

    tick();
    const interval = setInterval(tick, 2000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearInterval(clock);
    };
  }, [id, poll]);

  const handleRefresh = async () => {
    if (!id) return;
    setRefreshing(true);
    try {
      await apiRequest(`/accounts/${id}/refresh-qr`, { method: "POST" });
      await poll();
    } catch (err: any) {
      setError(err.message || "Не удалось обновить код");
    } finally {
      setRefreshing(false);
    }
  };

  const connected = data?.status === "CONNECTED";
  // Once the server has stopped the browser without a QR on screen, the code is
  // gone for good until somebody asks for a new one.
  const expired = !!data && !connected && !data.qr && !data.running && startedRef.current;
  const msLeft = data?.qrExpiresAt ? data.qrExpiresAt - now : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm text-center space-y-4">
        <div className="flex items-center justify-center gap-2">
          <MessageCircle className="h-6 w-6 text-primary" />
          <h1 className="text-xl font-display font-bold">Подключение WhatsApp</h1>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {!error && connected && (
          <div className="flex flex-col items-center gap-2 py-8">
            <CheckCircle2 className="h-16 w-16 text-wa-green" />
            <p className="font-medium">WhatsApp подключен!</p>
            <p className="text-sm text-muted-foreground">Можно закрыть эту страницу.</p>
          </div>
        )}

        {!error && !connected && (
          <>
            {expired ? (
              <div className="border-2 border-dashed border-destructive/40 rounded-lg p-6 flex flex-col items-center gap-3">
                <AlertTriangle className="h-8 w-8 text-destructive" />
                <p className="text-sm text-muted-foreground">
                  QR-код устарел. Нажмите, чтобы получить новый.
                </p>
                <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
                  {refreshing ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  )}
                  Обновить код
                </Button>
              </div>
            ) : (
              <>
                <div className="border p-2 bg-white rounded-lg inline-block mx-auto">
                  {data?.qr ? (
                    <img src={data.qr} alt="WhatsApp QR Code" className="h-64 w-64 object-contain" />
                  ) : (
                    <div className="h-64 w-64 flex items-center justify-center">
                      <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    </div>
                  )}
                </div>
                {data?.qr && msLeft !== null && (
                  <p className="text-xs text-muted-foreground">
                    Код действителен ещё {formatCountdown(msLeft)}
                  </p>
                )}
              </>
            )}

            <div className="text-xs text-muted-foreground space-y-1">
              <p>1. Откройте WhatsApp на телефоне.</p>
              <p>2. Настройки &rarr; Связанные устройства &rarr; Привязка устройства.</p>
              <p>3. Наведите камеру на этот QR-код.</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default ConnectAccount;
