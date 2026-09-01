import { useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Copy, Trash2, MessageSquareText, Sparkles, Loader2 } from "lucide-react";
import { motion } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Template } from "@/types";

const extractVars = (text: string) => {
  const matches = text.match(/\{\{(\w+)\}\}/g);
  return matches ? [...new Set(matches.map((m) => m.replace(/[{}]/g, "")))] : [];
};

const Templates = () => {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", body: "" });

  // Queries
  const { data: templates = [], isLoading } = useQuery<Template[]>({
    queryKey: ["templates"],
    queryFn: () => apiRequest("/templates")
  });

  // Mutations
  const createMutation = useMutation({
    mutationFn: (data: { name: string; body: string; variables: string[] }) =>
      apiRequest("/templates", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      setDialogOpen(false);
      toast.success("Шаблон создан");
    },
    onError: (err: any) => toast.error(err.message)
  });

  const updateMutation = useMutation({
    mutationFn: (data: { id: string; name: string; body: string; variables: string[] }) =>
      apiRequest(`/templates/${data.id}`, { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      setDialogOpen(false);
      toast.success("Шаблон обновлен");
    },
    onError: (err: any) => toast.error(err.message)
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/templates/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      toast.success("Шаблон удален");
    },
    onError: (err: any) => toast.error(err.message)
  });

  const openNew = () => {
    setEditId(null);
    setForm({ name: "", body: "" });
    setDialogOpen(true);
  };

  const openEdit = (t: Template) => {
    setEditId(t.id);
    setForm({ name: t.name, body: t.body });
    setDialogOpen(true);
  };

  const handleSave = () => {
    if (!form.name || !form.body) {
      toast.error("Заполните название и текст шаблона");
      return;
    }
    const vars = extractVars(form.body);
    if (editId) {
      updateMutation.mutate({ id: editId, name: form.name, body: form.body, variables: vars });
    } else {
      createMutation.mutate({ name: form.name, body: form.body, variables: vars });
    }
  };

  const handleDelete = (id: string) => {
    deleteMutation.mutate(id);
  };

  const handleCopy = (body: string) => {
    navigator.clipboard.writeText(body);
    toast.success("Скопировано в буфер обмена");
  };

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto space-y-6">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-display font-bold">Шаблоны сообщений</h1>
            <p className="text-muted-foreground mt-1">Используйте <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{"{{переменная}}"}</code> для персонализации (например, {"{{field_1}}"})</p>
          </div>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button onClick={openNew} className="gradient-primary text-primary-foreground shadow-glow gap-2">
                <Plus className="h-4 w-4" /> Новый шаблон
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle className="font-display">{editId ? "Редактировать" : "Новый"} шаблон</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-2">
                <div>
                  <Label>Название</Label>
                  <Input placeholder="Например: Приветствие" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div>
                  <Label>Текст сообщения</Label>
                  <Textarea rows={5} placeholder="Здравствуйте, {{field_1}}! ..." value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
                  {extractVars(form.body).length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {extractVars(form.body).map((v) => (
                        <Badge key={v} variant="secondary" className="text-xs">
                          <Sparkles className="h-3 w-3 mr-1" />{v}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <Button onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending} className="w-full gradient-primary text-primary-foreground">
                  {editId ? "Сохранить" : "Создать"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </motion.div>

        {isLoading ? (
          <div className="flex justify-center items-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {templates.map((t, i) => (
              <motion.div key={t.id} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}>
                <Card className="hover:shadow-md transition-shadow group h-full flex flex-col">
                  <CardHeader className="pb-2 flex flex-row items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className="h-8 w-8 rounded-lg bg-accent flex items-center justify-center">
                        <MessageSquareText className="h-4 w-4 text-primary" />
                      </div>
                      <CardTitle className="text-sm font-display cursor-pointer hover:text-primary transition-colors" onClick={() => openEdit(t)}>
                        {t.name}
                      </CardTitle>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleCopy(t.body)}>
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDelete(t.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1">
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">{t.body}</p>
                    {t.variables.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-3">
                        {t.variables.map((v) => (
                          <Badge key={v} variant="outline" className="text-[11px]">{v}</Badge>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            ))}
            {templates.length === 0 && (
              <div className="col-span-full text-center py-10 text-muted-foreground text-sm">
                Нет шаблонов сообщений. Создайте первый!
              </div>
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};

export default Templates;
