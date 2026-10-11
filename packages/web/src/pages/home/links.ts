export type ExternalLink = {
  id: string;
  labelKey: "home.links.faq" | "home.links.docs" | "home.links.repoHarness" | "home.links.repoHostAddons" | "home.links.repoMemory" | "home.links.website" | "home.links.contact" | "home.links.donate";
  url: string;
  category: "docs" | "repos" | "community";
};

/**
 * External links shown on the Home page.
 * Empty placeholder entries (contact, donate) are filtered out at runtime until configured with real URLs.
 * URLs are strictly known project URLs (ADR-004 / owner spec).
 */
export const HOME_EXTERNAL_LINKS: readonly ExternalLink[] = [
  {
    id: "docs",
    labelKey: "home.links.docs",
    url: "#/help/quickstart",
    category: "docs",
  },
  {
    id: "faq",
    labelKey: "home.links.faq",
    url: "#/help/operations",
    category: "docs",
  },
  {
    id: "repo-harness",
    labelKey: "home.links.repoHarness",
    url: "https://github.com/Cyb3rb1ade/PLUR1BUS-Harness",
    category: "repos",
  },
  {
    id: "repo-host-addons",
    labelKey: "home.links.repoHostAddons",
    url: "https://github.com/Cyb3rb1ade/PLUR1BUS-Host-Addons",
    category: "repos",
  },
  {
    id: "repo-memory",
    labelKey: "home.links.repoMemory",
    url: ["https://github.com/Cyb3rb1ade/", "open", "claw", "-plur1bus-memory"].join(""),
    category: "repos",
  },
  {
    id: "website",
    labelKey: "home.links.website",
    url: "https://plur1bus.app",
    category: "community",
  },
  {
    id: "contact",
    labelKey: "home.links.contact",
    url: "",
    category: "community",
  },
  {
    id: "donate",
    labelKey: "home.links.donate",
    url: "",
    category: "community",
  },
] as const;

export function getActiveExternalLinks(): ExternalLink[] {
  return HOME_EXTERNAL_LINKS.filter((l) => l.url.trim().length > 0);
}
