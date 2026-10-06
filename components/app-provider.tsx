"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Toaster, toast } from "sonner";
import { usePathname } from "next/navigation";
import type { AppState } from "@/lib/types";
import { DEFAULT_GEMINI_MODEL } from "@/lib/config";
type ApiResult = { state?: AppState; [key: string]: unknown };
interface AppContext {
  state: AppState | null;
  loading: boolean;
  error: string | null;
  mode: "demo" | "supabase";
  capabilities: {
    gemini: boolean;
    telegram: boolean;
    google: boolean;
    geminiModel?: string;
  };
  refresh: () => Promise<void>;
  mutate: <T extends ApiResult>(
    url: string,
    body?: unknown,
    method?: string,
  ) => Promise<T | undefined>;
  captureOpen: boolean;
  setCaptureOpen: (v: boolean) => void;
  commandOpen: boolean;
  setCommandOpen: (v: boolean) => void;
}
const Context = createContext<AppContext | null>(null);
export function AppProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [state, setState] = useState<AppState | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [mode, setMode] = useState<"demo" | "supabase">("demo"),
    [capabilities, setCapabilities] = useState<AppContext["capabilities"]>({
      gemini: false,
      telegram: false,
      google: false,
      geminiModel: DEFAULT_GEMINI_MODEL,
    }),
    [captureOpen, setCaptureOpen] = useState(false),
    [commandOpen, setCommandOpen] = useState(false);
  const refresh = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = "/login";
          return;
        }
        throw new Error(data.error || "Could not load your workspace.");
      }
      setState(data.state);
      setMode(data.mode);
      setCapabilities(data.capabilities);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection failed.");
    } finally {
      setLoading(false);
    }
  }, []);
  const mutate = useCallback(
    async <T extends ApiResult>(
      url: string,
      body?: unknown,
      method = "POST",
    ): Promise<T | undefined> => {
      try {
        const response = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const data = (await response.json()) as T & { error?: string };
        if (!response.ok)
          throw new Error(data.error || "That action could not be completed.");
        if (data.state) setState(data.state);
        return data;
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Connection failed. Please retry.",
        );
        return undefined;
      }
    },
    [],
  );
  useEffect(() => {
    if (pathname !== "/login" && pathname !== "/register") void refresh();
  }, [refresh, pathname]);
  useEffect(() => {
    if (!state) return;
    const dark =
      state.settings.theme === "dark" ||
      (state.settings.theme === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  }, [state]);
  return (
    <Context.Provider
      value={{
        state,
        loading,
        error,
        mode,
        capabilities,
        refresh,
        mutate,
        captureOpen,
        setCaptureOpen,
        commandOpen,
        setCommandOpen,
      }}
    >
      {children}
      <Toaster position="bottom-right" closeButton />
    </Context.Provider>
  );
}
export function useApp() {
  const context = useContext(Context);
  if (!context) throw new Error("AppProvider missing");
  return context;
}
