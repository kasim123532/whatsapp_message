import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { apiRequest } from "@/lib/api";
import { Loader2, CheckCircle2, MessageCircle } from "lucide-react";

interface AccountStatus {
  id: string;
  phone: string | null;
  name: string | null;
  status: "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "BANNED";
  qr: string | null;
}

const ConnectAccount = () => {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<AccountStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res: AccountStatus = await apiRequest(`/accounts/${id}/status`);
        if (cancelled) return;
        setData(res);
        setError(null);
        if (!startedRef.current && res.status === "DISCONNECTED") {
          startedRef.current = true;
          apiRequest(`/accounts/${id}/connect`, { method: "POST" }).catch(() => {});
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message || "Ссылка недействительна");
      }
    };

    poll();
    const interval = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [id]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm text-center space-y-4">
        <div className="flex items-center justify-center gap-2">
          <MessageCircle className="h-6 w-6 text-primary" />
          <h1 className="text-xl font-display font-bold">Подключение WhatsApp</h1>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {!error && data?.status === "CONNECTED" && (
          <div className="flex flex-col items-center gap-2 py-8">
            <CheckCircle2 className="h-16 w-16 text-wa-green" />
            <p className="font-medium">WhatsApp подключен!</p>
            <p className="text-sm text-muted-foreground">Можно закрыть эту страницу.</p>
          </div>
        )}

        {!error && data?.status !== "CONNECTED" && (
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
