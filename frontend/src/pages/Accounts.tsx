import { useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { MessageCircle, Plus, Settings, UserCog, Trash2, Loader2, Wifi, WifiOff } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api";
import { toast } from "sonner";
import { WhatsAppProfile } from "@/types";

function getAvatarNumber(phone: string | null, id: string) {
  return (phone || id).slice(-2);
}

const Accounts = () => {
  const queryClient = useQueryClient();

  const [addOpen, setAddOpen] = useState(false);
  const [limitOpen, setLimitOpen] = useState(false);
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [activeQrId, setActiveQrId] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newProxy, setNewProxy] = useState("");
  const [dayLimit, setDayLimit] = useState("");
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});

  // 1. Fetch profiles query
  const { data: profiles = [], isLoading } = useQuery<WhatsAppProfile[]>({
    queryKey: ["accounts"],
    queryFn: () => apiRequest("/accounts")
  });

  // Mutations
  const addMutation = useMutation({
    mutationFn: (data: { name?: string; proxy?: string }) =>
      apiRequest("/accounts", {
        method: "POST",
        body: JSON.stringify(data)
      }),
    onSuccess: (newProfile) => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      setAddOpen(false);
      setNewName("");
      setNewProxy("");
      toast.success("Профиль успешно создан");

      // Auto initiate connection
      connectMutation.mutate(newProfile.id);
    },
    onError: (err: any) => {
      toast.error(err.message || "Ошибка добавления аккаунта");
    }
  });

  const connectMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/accounts/${id}/connect`, { method: "POST" }),
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

  const disconnectMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/accounts/${id}/disconnect`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast.success("Сессия закрыта");
    },
    onError: (err: any) => {
      toast.error(err.message || "Ошибка отключения");
    }
  });

  const limitMutation = useMutation({
    mutationFn: (data: { ids: string[]; limit: number }) =>
      apiRequest("/accounts/limit", {
        method: "POST",
        body: JSON.stringify(data)
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      setLimitOpen(false);
      setDayLimit("");
      setSelectedIds({});
      toast.success("Лимиты установлены");
    },
    onError: (err: any) => {
      toast.error(err.message || "Ошибка установки лимита");
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast.success("Аккаунт удален");
    },
    onError: (err: any) => {
      toast.error(err.message || "Ошибка удаления");
    }
  });

  const activeProfileForQr = profiles.find((p) => p.id === activeQrId);
  const activeQrLink = activeQrId ? `${window.location.origin}/connect/${activeQrId}` : "";

  const onlineCount = profiles.filter((p) => p.status === "CONNECTED").length;
  const banCount = profiles.filter((p) => p.status === "BANNED").length;

  const handleAdd = () => {
    addMutation.mutate({
      name: newName.trim(),
      proxy: newProxy.trim()
    });
  };

  const copyInviteLink = () => {
    if (!activeQrLink) return;
    navigator.clipboard.writeText(activeQrLink);
    toast.success("Ссылка скопирована");
  };

  const handleSetLimit = () => {
    const lim = parseInt(dayLimit) || 0;
    const ids = Object.keys(selectedIds).filter((id) => selectedIds[id]);
    limitMutation.mutate({ ids, limit: lim });
  };

  const handleDeleteSelected = () => {
    const ids = Object.keys(selectedIds).filter((id) => selectedIds[id]);
    ids.forEach((id) => deleteMutation.mutate(id));
    setSelectedIds({});
  };

  const toggleAll = () => {
    if (Object.keys(selectedIds).length === profiles.length) {
      setSelectedIds({});
    } else {
      const all: Record<string, boolean> = {};
      profiles.forEach((p) => {
        all[p.id] = true;
      });
      setSelectedIds(all);
    }
  };

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => ({
      ...prev,
      [id]: !prev[id]
    }));
  };

  const isAllSelected = profiles.length > 0 && Object.keys(selectedIds).filter(k => selectedIds[k]).length === profiles.length;
  const isSomeSelected = Object.keys(selectedIds).filter(k => selectedIds[k]).length > 0;

  const statusBadge = (status: WhatsAppProfile["status"]) => {
    if (status === "CONNECTED") {
      return (
        <Badge className="bg-wa-green/20 text-wa-green border-wa-green/30 hover:bg-wa-green/20 text-[10px] px-1.5 py-0">
          Online
        </Badge>
      );
    }
    if (status === "CONNECTING") {
      return (
        <Badge className="bg-wa-amber/20 text-wa-amber border-wa-amber/30 hover:bg-wa-amber/20 text-[10px] px-1.5 py-0 animate-pulse">
          Connecting
        </Badge>
      );
    }
    if (status === "BANNED") {
      return (
        <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
          Banned
        </Badge>
      );
    }
    return (
      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
        Disconnected
      </Badge>
    );
  };

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto space-y-6">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex items-center gap-2">
            <MessageCircle className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-display font-bold">Аккаунты WhatsApp</h1>
          </div>
        </motion.div>

        <div className="flex flex-col md:flex-row gap-6">
          {/* Sidebar */}
          <div className="w-full md:w-56 shrink-0">
            <Button
              variant="outline"
              className="w-full justify-start gap-2"
              onClick={() => setAddOpen(true)}
            >
              <MessageCircle className="h-4 w-4 text-primary" />
              Добавить аккаунт
            </Button>
          </div>

          {/* Main Content */}
          <Card className="flex-1">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MessageCircle className="h-5 w-5 text-primary" />
                  <CardTitle className="text-lg font-display">Профили WhatsApp</CardTitle>
                </div>
                <span className="text-sm text-muted-foreground">
                  Online: {onlineCount} / Banned: {banCount}
                </span>
              </div>
            </CardHeader>
            <CardContent className="space-y-0">
              {/* Toolbar */}
              <div className="flex items-center justify-between border-b pb-3 mb-1">
                <div className="flex items-center gap-3">
                  <Checkbox
                    checked={isAllSelected}
                    onCheckedChange={toggleAll}
                  />
                  <span className="text-sm font-medium">Отметить все</span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!isSomeSelected}
                    onClick={() => setLimitOpen(true)}
                  >
                    <Settings className="h-3.5 w-3.5 mr-1" /> Лимит
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!isSomeSelected}
                    onClick={handleDeleteSelected}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {/* Column header */}
              <div className="flex items-center justify-between text-xs text-muted-foreground px-1 py-2 border-b">
                <span>Phone / Имя / Proxy</span>
                <span className="mr-24">Статус</span>
                <span>Сегодня / Limit / Всего</span>
              </div>

              {/* Profiles list */}
              {isLoading ? (
                <div className="flex justify-center items-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : (
                <AnimatePresence>
                  {profiles.map((p) => (
                    <motion.div
                      key={p.id}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 10 }}
                      className="flex items-center justify-between py-3 px-1 border-b last:border-0 hover:bg-muted/30 transition-colors"
                    >
                      <div className="flex items-center gap-3 w-1/2">
                        <Checkbox
                          checked={!!selectedIds[p.id]}
                          onCheckedChange={() => toggleOne(p.id)}
                        />
                        <div className="h-10 w-10 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-display font-bold text-sm shrink-0">
                          {getAvatarNumber(p.phone, p.id)}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">
                              {p.phone ? `+${p.phone}` : "Ожидание сканирования QR"}
                              {p.name && ` (${p.name})`}
                            </span>
                          </div>
                          {p.proxy && (
                            <span className="text-xs text-muted-foreground block">
                              Proxy: {p.proxy}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Connection Buttons */}
                      <div className="flex items-center gap-2 w-1/4">
                        {statusBadge(p.status)}
                        {p.status === "CONNECTED" ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs px-2 text-muted-foreground"
                            onClick={() => disconnectMutation.mutate(p.id)}
                          >
                            <WifiOff className="h-3 w-3 mr-1" /> Выйти
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs px-2 border-wa-green/30 text-wa-green hover:bg-wa-green/10"
                            onClick={() => connectMutation.mutate(p.id)}
                            disabled={p.status === "CONNECTING"}
                          >
                            <Wifi className="h-3 w-3 mr-1" /> Войти
                          </Button>
                        )}
                        {p.status === "CONNECTING" && (
                          <Button
                            variant="link"
                            size="sm"
                            className="h-7 text-xs text-primary px-1"
                            onClick={() => {
                              setActiveQrId(p.id);
                              setQrDialogOpen(true);
                            }}
                          >
                            QR
                          </Button>
                        )}
                      </div>

                      <span className="text-sm text-muted-foreground font-mono w-1/6 text-right">
                        {p.todaySent} / {p.dailyLimit} / {p.totalSent}
                      </span>
                    </motion.div>
                  ))}
                  {profiles.length === 0 && (
                    <div className="text-center py-10 text-muted-foreground text-sm">
                      Нет подключенных профилей. Добавьте первый аккаунт.
                    </div>
                  )}
                </AnimatePresence>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Add profile dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Добавить WhatsApp профиль</DialogTitle>
            <DialogDescription>
              Номер телефона вводить не нужно — он определится автоматически после сканирования QR-кода.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-semibold">Имя профиля (для себя)</label>
              <Input
                placeholder="Call-центр 1"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold">Proxy (опционально)</label>
              <Input
                placeholder="http://user:pass@ip:port"
                value={newProxy}
                onChange={(e) => setNewProxy(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Отмена</Button>
            <Button onClick={handleAdd} disabled={addMutation.isPending}>
              {addMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Добавить и подключить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      {/* Set limit dialog */}
      <Dialog open={limitOpen} onOpenChange={setLimitOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Установить лимит сообщений</DialogTitle>
            <DialogDescription>
              Максимальное количество сообщений в день для выбранных профилей.
            </DialogDescription>
          </DialogHeader>
          <Input
            type="number"
            placeholder="Лимит (например, 200)"
            value={dayLimit}
            onChange={(e) => setDayLimit(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setLimitOpen(false)}>Отмена</Button>
            <Button onClick={handleSetLimit} disabled={limitMutation.isPending}>
              Применить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
};

export default Accounts;
