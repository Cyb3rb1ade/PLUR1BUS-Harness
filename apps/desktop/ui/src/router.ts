export type Section = "home" | "settings" | "connections";
export type SettingsPage = "runtime" | "updates" | "version" | "advanced";
export type Route = { section: Section; page: SettingsPage };

export function routeFromHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "connections") return { section: "connections", page: "runtime" };
  if (parts[0] === "settings") {
    const page = parts[1] ?? "";
    return { section: "settings", page: ["runtime", "updates", "version", "advanced"].includes(page) ? page as SettingsPage : "runtime" };
  }
  return { section: "home", page: "runtime" };
}

export function hashFor(route: Route): string {
  return route.section === "settings" ? `#/settings/${route.page}` : `#/${route.section}`;
}
