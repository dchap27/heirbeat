export type AppView = "home" | "dashboard" | "open" | "create";

export function viewForPath(pathname: string): AppView {
  if (pathname === "/open-vault") return "open";
  if (pathname === "/create-vault") return "create";
  if (/^\/vault\/[^/]+\/?$/.test(pathname)) return "dashboard";
  return "home";
}

export function pathForView(view: AppView, vaultId?: string | null): string {
  if (view === "open") return "/open-vault";
  if (view === "create") return "/create-vault";
  if (view === "dashboard" && vaultId) return `/vault/${encodeURIComponent(vaultId)}`;
  return "/";
}
