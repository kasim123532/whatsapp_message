import { useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QrDialog } from "@/components/QrDialog";
import { QrCode, Loader2 } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api";
import { toast } from "sonner";
import { Proxy, WhatsAppProfile } from "@/types";

const NO_PROXY = "__none__";

const QrGenerator = () => {
  const queryClient = useQueryClient();
  const [selectedProxy, setSelectedProxy] = useState(NO_PROXY);
  const [profileName, setProfileName] = useState("");
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
    mutationFn: (body: { proxy: string; name: string }) =>
      // draft: the profile is thrown away again if nobody scans the code.
      apiRequest("/accounts", {
        method: "POST",
        body: JSON.stringify({ ...body, draft: true })
      }),
    onSuccess: (newProfile: WhatsAppProfile) => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      connectMutation.mutate(newProfile.id);
    },
    onError: (err: any) => {
      toast.error(err.message || "Ошибка создания аккаунта");
    }
  });

  const activeProfileForQr = accounts.find((a) => a.id === activeQrId) ?? null;
  const isBusy = generateMutation.isPending || connectMutation.isPending;

  const handleGenerate = () => {
    generateMutation.mutate({
      proxy: selectedProxy === NO_PROXY ? "" : selectedProxy,
      name: profileName.trim()
    });
  };

  const handleDialogChange = (open: boolean) => {
    setQrDialogOpen(open);
    if (!open) {
      setActiveQrId(null);
      // A finished login keeps its name; a discarded draft leaves nothing behind.
      setProfileName("");
    }
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
              <label className="text-xs font-semibold">Имя профиля (опционально)</label>
              <Input
                placeholder="Call-центр 1"
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Номер определится сам после сканирования QR-кода.
              </p>
            </div>

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

            <Button className="w-full" onClick={handleGenerate} disabled={isBusy}>
              {isBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Сгенерировать QR
            </Button>
            <p className="text-xs text-muted-foreground">
              Пока код не отсканирован, профиль считается черновиком: он исчезнет,
              если закрыть окно или не отсканировать код вовремя.
            </p>
          </CardContent>
        </Card>
      </div>

      <QrDialog
        open={qrDialogOpen}
        onOpenChange={handleDialogChange}
        profile={activeProfileForQr}
      />
    </DashboardLayout>
  );
};

export default QrGenerator;
