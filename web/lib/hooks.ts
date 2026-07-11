import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./api";

export const useStats = () => useQuery({ queryKey: ["stats"], queryFn: api.stats });
export const useTrades = () => useQuery({ queryKey: ["trades"], queryFn: api.trades });
export const useMeta = () => useQuery({ queryKey: ["meta"], queryFn: api.meta });
export const usePositions = () => useQuery({ queryKey: ["positions"], queryFn: api.positions });
export const useBreakdowns = (by: string) =>
  useQuery({ queryKey: ["breakdowns", by], queryFn: () => api.breakdowns(by), placeholderData: keepPreviousData });
export const useTradeDetail = (id: string) =>
  useQuery({ queryKey: ["trade", id], queryFn: () => api.trade(id), enabled: !!id });

/** Poll sync status only while a sync is running; when it flips to done, invalidate everything so
 * the whole app refetches the freshly-synced data (one place, not a manual refetch cascade). */
export function useSyncStatus() {
  const qc = useQueryClient();
  const [wasRunning, setWasRunning] = useState(false);
  const q = useQuery({
    queryKey: ["syncStatus"],
    queryFn: api.syncStatus,
    refetchInterval: (query) => (query.state.data?.running ? 1200 : false),
  });
  useEffect(() => {
    const running = q.data?.running ?? false;
    if (wasRunning && !running) {
      // sync just finished → refresh all data-bearing queries
      for (const key of ["stats", "trades", "positions", "meta", "breakdowns"]) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    }
    setWasRunning(running);
  }, [q.data?.running, wasRunning, qc]);
  return q;
}

export function useStartSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.startSync,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["syncStatus"] }),
  });
}

// ---- theme ----
export type ThemeMode = "light" | "dark" | "system";

/** Persisted light/dark toggle. "system" follows prefers-color-scheme; the explicit modes stamp
 * data-theme on <html> so CSS light-dark() resolves the forced scheme. */
export function useTheme(): [ThemeMode, (m: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(
    () => (localStorage.getItem("theme") as ThemeMode) || "system",
  );
  useEffect(() => {
    const root = document.documentElement;
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
    localStorage.setItem("theme", mode);
  }, [mode]);
  return [mode, setMode];
}
