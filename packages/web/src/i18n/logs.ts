// logs area catalogue (Logs page shell and the log viewer tab, `/logs`): keys `logs.<topic>`; en and de have the same keys and {placeholders}.
export const en = {
  "logs.tabs": "Log views",
  "logs.tab.logs": "Logs",
  "logs.tab.activity": "Activity",
  "logs.tab.sessions": "Sessions",
} as const;

export const de: Record<keyof typeof en, string> = {
  "logs.tabs": "Protokollansichten",
  "logs.tab.logs": "Protokolle",
  "logs.tab.activity": "Aktivität",
  "logs.tab.sessions": "Sitzungen",
};
