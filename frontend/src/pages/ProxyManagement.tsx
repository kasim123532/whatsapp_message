import { useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Network, Trash2, Loader2 } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api";
import { toast } from "sonner";
import { Proxy } from "@/types";

const ProxyManagement = () => {
  const queryClient = useQueryClient();
  const [proxyText, setProxyText] = useState("");

  const { data: proxies = [], isLoading } = useQuery<Proxy[]>({
    queryKey: ["proxies"],
    queryFn: () => apiRequest("/proxies")
  });

  const addProxiesMutation = useMutation({
    mutationFn: (text: string) =>
      apiRequest("/proxies", { method: "POST", body: JSON.stringify({ text }) }),
    onSuccess: (res: { added: number; skipped: number; invalid?: string[] }) => {
      queryClient.invalidateQueries({ queryKey: ["proxies"] });
      setProxyText("");
      toast.success(`Добавлено: ${res.added}${res.skipped ? `, пропущено дублей: ${res.skipped}` : ""}`);
      if (res.invalid?.length) {
        toast.error(
          `Не распознано ${res.invalid.length} строк: ${res.invalid.slice(0, 3).join(", ")}${
            res.invalid.length > 3 ? "…" : ""
          }`
        );
      }
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

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-2">
          <Network className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-display font-bold">Управление прокси</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg font-display">Добавить прокси</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              По одному прокси на строку: <code>host:port</code>,{" "}
              <code>host:port:username:password</code> или{" "}
              <code>scheme://username:password@host:port</code> (http, https, socks4, socks5).
            </p>
            <Textarea
              rows={4}
              placeholder={"1.2.3.4:8080\n1.2.3.5:8080:user:pass\nsocks5://user:pass@1.2.3.6:1080"}
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
            <CardTitle className="text-lg font-display">
              Список прокси {proxies.length > 0 && `(${proxies.length})`}
            </CardTitle>
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
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs px-2 text-destructive hover:text-destructive shrink-0"
                      onClick={() => deleteProxyMutation.mutate(p.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" /> Удалить
                    </Button>
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
    </DashboardLayout>
  );
};

export default ProxyManagement;
