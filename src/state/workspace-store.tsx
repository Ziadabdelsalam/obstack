"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { seedDashboards, type Dashboard, type Widget } from "@/mock/dashboards";
import { seedChannels, type NotificationChannel } from "@/mock/oncall";

interface WorkspaceState {
  dashboards: Dashboard[];
  createDashboard: (name: string) => string;
  addWidget: (dashboardId: string, w: Omit<Widget, "id">) => void;
  removeWidget: (dashboardId: string, widgetId: string) => void;
  moveWidget: (dashboardId: string, widgetId: string, dir: "up" | "down") => void;
  channels: NotificationChannel[];
  toggleChannel: (id: string) => void;
}

const Ctx = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [dashboards, setDashboards] = useState<Dashboard[]>(seedDashboards);
  const [channels, setChannels] = useState<NotificationChannel[]>(seedChannels);
  const counter = useRef(0); // monotonic ids — no Math.random (determinism rule)

  const createDashboard = useCallback((name: string) => {
    const id = `custom-${++counter.current}`;
    setDashboards((ds) => [...ds, { id, name, owner: "You", updated: "just now", widgets: [] }]);
    return id;
  }, []);

  const addWidget = useCallback((dashboardId: string, w: Omit<Widget, "id">) => {
    setDashboards((ds) =>
      ds.map((d) =>
        d.id === dashboardId
          ? { ...d, updated: "just now", widgets: [...d.widgets, { ...w, id: `wu-${++counter.current}` }] }
          : d,
      ),
    );
  }, []);

  const removeWidget = useCallback((dashboardId: string, widgetId: string) => {
    setDashboards((ds) =>
      ds.map((d) =>
        d.id === dashboardId ? { ...d, widgets: d.widgets.filter((w) => w.id !== widgetId) } : d,
      ),
    );
  }, []);

  const moveWidget = useCallback((dashboardId: string, widgetId: string, dir: "up" | "down") => {
    setDashboards((ds) =>
      ds.map((d) => {
        if (d.id !== dashboardId) return d;
        const i = d.widgets.findIndex((w) => w.id === widgetId);
        const j = dir === "up" ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= d.widgets.length) return d;
        const widgets = [...d.widgets];
        [widgets[i], widgets[j]] = [widgets[j], widgets[i]];
        return { ...d, widgets };
      }),
    );
  }, []);

  const toggleChannel = useCallback((id: string) => {
    setChannels((cs) => cs.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)));
  }, []);

  return (
    <Ctx.Provider
      value={{ dashboards, createDashboard, addWidget, removeWidget, moveWidget, channels, toggleChannel }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useWorkspace(): WorkspaceState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return v;
}
