// devices area catalogue (Settings > Devices & remote): keys `devices.<topic>`; en and de have the same keys and {placeholders}.
export const en = {
  "devices.title": "Devices & remote",
  "devices.off.title": "Remote access is off",
  "devices.off.body": "This harness is not published beyond this machine (remote.publish is local), so there is nothing to pair.",
  "devices.mode": "Remote access",
  "devices.mode.value": "Published as {mode}",
  "devices.list": "Paired devices",
  "devices.list.unavailable": "Paired devices (name, fingerprint, last seen) are not available on this harness yet.",
  "devices.pair": "Pair a device",
  "devices.pair.unavailable": "A QR code or deep link for pairing is not available on this harness yet.",
  "devices.remove": "Removing a device",
  "devices.remove.unavailable": "Removing a paired device is not available on this harness yet.",
} as const;

export const de: Record<keyof typeof en, string> = {
  "devices.title": "Geräte & Fernzugriff",
  "devices.off.title": "Fernzugriff ist aus",
  "devices.off.body": "Dieser Harness wird nicht über diese Maschine hinaus veröffentlicht (remote.publish ist local), daher gibt es nichts zu koppeln.",
  "devices.mode": "Fernzugriff",
  "devices.mode.value": "Veröffentlicht als {mode}",
  "devices.list": "Gekoppelte Geräte",
  "devices.list.unavailable": "Gekoppelte Geräte (Name, Fingerabdruck, zuletzt gesehen) sind bei diesem Harness noch nicht verfügbar.",
  "devices.pair": "Gerät koppeln",
  "devices.pair.unavailable": "Ein QR-Code oder Deep-Link zum Koppeln ist bei diesem Harness noch nicht verfügbar.",
  "devices.remove": "Gerät entfernen",
  "devices.remove.unavailable": "Das Entfernen eines gekoppelten Geräts ist bei diesem Harness noch nicht verfügbar.",
};
