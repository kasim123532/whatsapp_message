import { Users, MessageSquareText, Send, TrendingUp, Clock, CheckCircle2, Loader2, MessageCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DashboardLayout } from "@/components/DashboardLayout";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ContactGroup, Template, Campaign, WhatsAppProfile, SubGroup } from "@/types";

const statusMap: Record<string, { label: string; className: string }> = {
  COMPLETED: { label: "Завершена", className: "bg-accent text-accent-foreground" },
  RUNNING: { label: "Отправляется", className: "bg-wa-green-light text-wa-green-dark" },
  PAUSED: { label: "Пауза", className: "bg-wa-amber-light text-wa-amber" },
  DRAFT: { label: "Черновик", className: "bg-muted text-muted-foreground" },
};

const Index = () => {
  // Queries to load dashboard data
  const { data: contactGroups = [], isLoading: isContactsLoading } = useQuery<ContactGroup[]>({
    queryKey: ["contactGroups"],
    queryFn: () => apiRequest("/contacts/groups")
  });

  const { data: templates = [], isLoading: isTemplatesLoading } = useQuery<Template[]>({
    queryKey: ["templates"],
    queryFn: () => apiRequest("/templates")
  });

  const { data: campaigns = [], isLoading: isCampaignsLoading } = useQuery<Campaign[]>({
    queryKey: ["campaigns"],
    queryFn: () => apiRequest("/campaigns")
  });

  const { data: accounts = [], isLoading: isAccountsLoading } = useQuery<WhatsAppProfile[]>({
    queryKey: ["accounts"],
    queryFn: () => apiRequest("/accounts")
  });

  const isLoading = isContactsLoading || isTemplatesLoading || isCampaignsLoading || isAccountsLoading;

  // Calculators
  const totalContacts = contactGroups.reduce(
    (acc, g) => acc + g.subGroups.reduce((a: number, sg: SubGroup) => a + sg.contacts.length, 0),
    0
  );

  const totalTemplates = templates.length;
  const activeCampaigns = campaigns.filter(c => c.status === "RUNNING").length;
  const totalCampaigns = campaigns.length;
  
  // Calculate delivery rate from campaigns
  const totalSent = campaigns.reduce((acc, c) => acc + c.sent, 0);
  const totalFailed = campaigns.reduce((acc, c) => acc + c.failed, 0);
  const deliveryRate = totalSent + totalFailed > 0 
    ? ((totalSent / (totalSent + totalFailed)) * 100).toFixed(1) 
    : "100";

  const stats = [
    { label: "Контакты", value: String(totalContacts), icon: Users, change: "Всего в базе", color: "text-primary" },
    { label: "Шаблоны", value: String(totalTemplates), icon: MessageSquareText, change: "Шаблоны сообщений", color: "text-wa-teal" },
    { label: "Активные рассылки", value: `${activeCampaigns}/${totalCampaigns}`, icon: Send, change: "В процессе отправки", color: "text-wa-emerald" },
    { label: "Успешная доставка", value: `${deliveryRate}%`, icon: TrendingUp, change: `Отправлено: ${totalSent}`, color: "text-wa-amber" },
  ];

  const recentCampaigns = campaigns.slice(0, 3); // Get last 3 campaigns

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto space-y-8 font-body">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-3xl font-display font-bold">Дашборд</h1>
          <p className="text-muted-foreground mt-1">Обзор вашей системы рассылок</p>
        </motion.div>

        {isLoading ? (
          <div className="flex justify-center items-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {stats.map((stat, i) => (
                <motion.div key={stat.label} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08 }}>
                  <Card className="hover:shadow-md transition-shadow">
                    <CardContent className="pt-6">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs text-muted-foreground">{stat.label}</p>
                          <p className="text-2xl font-display font-bold mt-1">{stat.value}</p>
                          <p className={`text-[10px] mt-1 ${stat.color}`}>{stat.change}</p>
                        </div>
                        <div className="h-12 w-12 rounded-xl bg-accent flex items-center justify-center">
                          <stat.icon className={`h-6 w-6 ${stat.color}`} />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Recent Campaigns list */}
              <motion.div className="md:col-span-2" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}>
                <Card className="h-full">
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle className="text-lg font-display">Последние рассылки</CardTitle>
                    <Link to="/campaigns" className="text-sm text-primary hover:underline">Все рассылки →</Link>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {recentCampaigns.map((c) => {
                        const st = statusMap[c.status] || { label: c.status, className: "bg-muted text-muted-foreground" };
                        const totalRecipients = c.sent + c.pending + c.failed;
                        return (
                          <div key={c.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/40 hover:bg-muted/70 transition-colors">
                            <div className="flex items-center gap-3">
                              {c.status === "COMPLETED" ? (
                                <CheckCircle2 className="h-5 w-5 text-primary" />
                              ) : (
                                <Clock className="h-5 w-5 text-muted-foreground animate-pulse" />
                              )}
                              <div>
                                <p className="font-medium text-sm">{c.name}</p>
                                <p className="text-xs text-muted-foreground">
                                  {totalRecipients} контактов • Получатель: {c.group}
                                </p>
                              </div>
                            </div>
                            <span className={`text-[10px] px-2.5 py-1 rounded-full font-medium ${st.className}`}>
                              {st.label}
                            </span>
                          </div>
                        );
                      })}
                      {recentCampaigns.length === 0 && (
                        <p className="text-center py-6 text-sm text-muted-foreground">Нет недавних рассылок.</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </motion.div>

              {/* Connected Accounts Quick widget */}
              <motion.div className="md:col-span-1" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.45 }}>
                <Card className="h-full">
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle className="text-lg font-display">Аккаунты WhatsApp</CardTitle>
                    <Link to="/accounts" className="text-sm text-primary hover:underline">Детали →</Link>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {accounts.slice(0, 4).map((acc) => (
                        <div key={acc.id} className="flex items-center justify-between text-sm py-1 border-b last:border-0 pb-2 last:pb-0">
                          <div className="flex items-center gap-2">
                            <MessageCircle className={cn(
                              "h-4 w-4", 
                              acc.status === "CONNECTED" ? "text-wa-green" : "text-muted-foreground"
                            )} />
                            <span className="font-medium">{acc.phone ? `+${acc.phone}` : "Ожидание QR"}</span>
                          </div>
                          <span className={cn(
                            "text-[10px] font-bold",
                            acc.status === "CONNECTED" ? "text-wa-green" : "text-muted-foreground"
                          )}>
                            {acc.status === "CONNECTED" ? "ONLINE" : "OFFLINE"}
                          </span>
                        </div>
                      ))}
                      {accounts.length === 0 && (
                        <p className="text-center py-6 text-sm text-muted-foreground">Нет подключенных аккаунтов.</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
};

export default Index;
