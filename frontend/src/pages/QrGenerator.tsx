import { useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { QrCode, Loader2 } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api";
import { toast } from "sonner";
import { Proxy, WhatsAppProfile } from "@/types";

const NO_PROXY = "__none__";

const QrGenerator = () => {
  const queryClient = useQueryClient();
  const [selectedProxy, setSelectedProxy] = useState(NO_PROXY);
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [activeQrId, setActiveQrId] = useState<string | null>(null);

  const { data: proxies = [] } = useQuery<Proxy[]>({
    queryKey: ["proxies"],
    queryFn: () => apiRequest("/proxies")
  });

  const { data: accounts = [] } = useQuery<WhatsAppProfile[]>({
    queryKey: ["accounts"],
    queryFn: () => apiRequest("/accounts")
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

  const handleGenerate = () => {
    generateMutation.mutate(selectedProxy === NO_PROXY ? "" : selectedProxy);
  };

  return (
    <DashboardLayout>
      <div className="max-w-lg mx-auto space-y-6">
        <div className="flex items-center gap-2">
          <QrCode className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-display font-bold">Генерация QR</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg font-display">Новый WhatsApp профиль</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-semibold">Прокси (опционально)</label>
              <Select value={selectedProxy} onValueChange={setSelectedProxy}>
                <SelectTrigger>
                  <SelectValue placeholder="Выберите прокси" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PROXY}>Без прокси</SelectItem>
                  {proxies.map((p) => (
                    <SelectItem key={p.id} value={p.value}>
                      {p.value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {proxies.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Список прокси пуст — можно продолжить без прокси, либо добавить прокси на странице "Управление прокси".
                </p>
              )}
            </div>
            <Button
              className="w-full"
              onClick={handleGenerate}
              disabled={generateMutation.isPending || connectMutation.isPending}
            >
              {generateMutation.isPending || connectMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Сгенерировать QR
            </Button>
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
