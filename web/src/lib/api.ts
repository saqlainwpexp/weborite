import { useCallback, useEffect, useRef, useState } from "react";

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Fetch JSON and re-poll on an interval. */
export function usePoll<T>(path: string | null, intervalMs = 4000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const d = await api<T>(path);
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }, [path]);

  useEffect(() => {
    alive.current = true;
    setData(null);
    void reload();
    const t = setInterval(reload, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [reload, intervalMs]);

  return { data, error, reload };
}

export function timeAgo(iso?: string) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function shortDate(iso?: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

export function duration(a?: string, b?: string) {
  if (!a || !b) return "";
  const s = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export const fileUrl = (leadId: string, path: string) => `/files/leads/${leadId}/${path}`;
