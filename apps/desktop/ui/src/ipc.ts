import { invoke } from "@tauri-apps/api/core";
import type { LocaleChoice } from "./i18n.ts";

export type ThemeChoice = "system" | "light" | "dark";
export type Platform = "mac" | "win" | "gnome" | "kde";
export type Settings = { theme: ThemeChoice; locale: LocaleChoice };
export type DesktopTransport = {
  appInfo(): Promise<{ platform: Platform; locale: string }>;
  settingsGet(): Promise<Settings>;
  settingsSet(value: Settings): Promise<Settings>;
};

export const nativeTransport: DesktopTransport = {
  appInfo: () => invoke("app_info"),
  settingsGet: () => invoke("settings_get"),
  settingsSet: settings => invoke("settings_set", { request: { settings } }),
};
