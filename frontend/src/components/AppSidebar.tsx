import { Users, MessageSquareText, Send, LayoutDashboard, Settings, QrCode, Wand2, Network } from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { useLocation } from "react-router-dom";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";

const mainItems = [
  { title: "Дашборд", url: "/", icon: LayoutDashboard },
  { title: "Аккаунты", url: "/accounts", icon: MessageSquareText },
  { title: "Контакты", url: "/contacts", icon: Users },
  { title: "Шаблоны", url: "/templates", icon: MessageSquareText },
  { title: "Рассылки", url: "/campaigns", icon: Send },
  { title: "QR по прокси", url: "/qr", icon: QrCode },
  { title: "Управление прокси", url: "/proxies", icon: Network },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const location = useLocation();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-4">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg gradient-primary flex items-center justify-center shrink-0">
            <Send className="h-5 w-5 text-primary-foreground" />
          </div>
          {!collapsed && (
            <div>
              <h2 className="font-display text-sm font-bold text-sidebar-accent-foreground">WA Sender</h2>
              <p className="text-[11px] text-sidebar-foreground/60">Менеджер рассылок</p>
            </div>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-sidebar-foreground/40 text-[11px] uppercase tracking-wider">
            Меню
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {mainItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild>
                    <NavLink
                      to={item.url}
                      end={item.url === "/"}
                      className="hover:bg-sidebar-accent/60 transition-colors"
                      activeClassName="bg-sidebar-accent text-sidebar-primary font-medium"
                    >
                      <item.icon className="mr-2 h-4 w-4" />
                      {!collapsed && <span>{item.title}</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <a
                    href="https://goodparser.ru/phone-format"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:bg-sidebar-accent/60 transition-colors flex items-center"
                  >
                    <Wand2 className="mr-2 h-4 w-4" />
                    {!collapsed && <span>Форматирование</span>}
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <NavLink to="/settings" className="hover:bg-sidebar-accent/60" activeClassName="bg-sidebar-accent text-sidebar-primary">
                <Settings className="mr-2 h-4 w-4" />
                {!collapsed && <span>Настройки</span>}
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
