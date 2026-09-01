import { useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { QrCode, Trash2, Loader2 } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api";
import { toast } from "sonner";
import { Proxy, WhatsAppProfile } from "@/types";

const QrGenerator = () => {
  const queryClient = useQueryClient();
  const [proxyText, setProxyText] = useState("");
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [activeQrId, setActiveQrId] = useState<string | null>(null);

  const { data: proxies = [], isLoading } = useQuery<Proxy[]>({
    queryKey: ["proxies"],
    queryFn: () => apiRequest("/proxies")
  });

  const { data: accounts = [] } = useQuery<WhatsAppProfile[]>({
    queryKey: ["accounts"],
    queryFn: () => apiRequest("/accounts")
  });

  const addProxiesMutation = useMutation({
    mutationFn: (text: string) =>
      apiRequest("/proxies", { method: "POST", body: JSON.stringify({ text }) }),
    onSuccess: (res: { added: number; skipped: number }) => {
      queryClient.invalidateQueries({ queryKey: ["proxies"] });
      setProxyText("");
      toast.success(`Добавлено: ${res.added}${res.skipped ? `, пропущено дублей: ${res.skipped}` : ""}`);
    },
    onError: (err: any) => {
      toast.error(err.message || "Ошибка добавления прокси");
    }
  });

  const deleteProxyMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/proxies/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["proxies"] });
      toast.success("Прокси удален");
    },
    onError: (err: any) => {
      toast.error(err.message || "Ошибка удаления прокси");
    }
  });

  const connectMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/accounts/${id}/connect`, { method: "POST" }),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      setActiveQrId(id);
      setQrDialogOpen(true);
      toast.info("Инициализация подключения...");
    },
    onError: (err: any) => {
      toast.error(err.message || "Ошибка подключения");
    }
  });

  const generateMutation = useMutation({
    mutationFn: (proxy: string) =>
      apiRequest("/accounts", { method: "POST", body: JSON.stringify({ proxy }) }),
    onSuccess: (newProfile) => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      connectMutation.mutate(newProfile.id);
    },
    onError: (err: any) => {
      toast.error(err.message || "Ошибка создания аккаунта");
    }
  });

  const activeProfileForQr = accounts.find((a) => a.id === activeQrId);
  const activeQrLink = activeQrId ? `${window.location.origin}/connect/${activeQrId}` : "";

  const copyInviteLink = () => {
    if (!activeQrLink) return;
    navigator.clipboard.writeText(activeQrLink);
    toast.success("Ссылка скопирована");
  };

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-2">
          <QrCode className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-display font-bold">Генерация QR по прокси</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg font-display">Добавить прокси</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              По одному прокси на строку: host:port или host:port:username:password
            </p>
            <Textarea
              rows={4}
              placeholder={"1.2.3.4:8080\n1.2.3.5:8080:user:pass"}
              value={proxyText}
              onChange={(e) => setProxyText(e.target.value)}
            />
            <Button
              onClick={() => proxyText.trim() && addProxiesMutation.mutate(proxyText)}
              disabled={!proxyText.trim() || addProxiesMutation.isPending}
            >
              {addProxiesMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Добавить
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg font-display">Доступные прокси</CardTitle>
          </CardHeader>
          <CardContent className="space-y-0">
            {isLoading ? (
              <div className="flex justify-center items-center py-10">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : (
              <>
                {proxies.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between py-3 border-b last:border-0"
                  >
                    <span className="text-sm font-mono truncate">{p.value}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs px-2 border-wa-green/30 text-wa-green hover:bg-wa-green/10"
                        onClick={() => generateMutation.mutate(p.value)}
                        disabled={generateMutation.isPending || connectMutation.isPending}
                      >
                        <QrCode className="h-3 w-3 mr-1" /> Сгенерировать QR
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs px-2 text-destructive hover:text-destructive"
                        onClick={() => deleteProxyMutation.mutate(p.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
                {proxies.length === 0 && (
                  <div className="text-center py-10 text-muted-foreground text-sm">
                    Нет добавленных прокси. Вставьте список выше.
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* QR Scanner dialog */}
      <Dialog open={qrDialogOpen} onOpenChange={setQrDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Авторизовать WhatsApp</DialogTitle>
            <DialogDescription>
              Отсканируйте QR-код в мобильном приложении WhatsApp.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center justify-center p-4">
            {activeProfileForQr?.qr ? (
              <div className="border p-2 bg-white rounded-lg">
                <img
                  src={activeProfileForQr.qr}
                  alt="WhatsApp QR Code"
                  className="h-64 w-64 object-contain"
                />
              </div>
            ) : (
              <div className="h-64 w-64 border-2 border-dashed border-muted-foreground/30 rounded-lg flex flex-col items-center justify-center text-muted-foreground text-sm p-4 text-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary mb-2" />
                Генерация QR-кода...
              </div>
            )}

            <div className="mt-4 space-y-2 text-xs text-muted-foreground">
              <p>1. Откройте WhatsApp на телефоне.</p>
              <p>2. Нажмите Меню (три точки) или Настройки &rarr; Связанные устройства.</p>
              <p>3. Нажмите "Привязка устройства" и наведите на этот код.</p>
            </div>
            <div className="mt-2 w-full">
              <p className="text-xs text-muted-foreground text-center mb-1">
                Подключает чужой WhatsApp? Отправьте ссылку — тот же QR откроется у него.
              </p>
              <Button variant="outline" size="sm" className="w-full" onClick={copyInviteLink}>
                Скопировать ссылку для отправки
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setQrDialogOpen(false)} className="w-full">
              Закрыть
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
};

export default QrGenerator;
