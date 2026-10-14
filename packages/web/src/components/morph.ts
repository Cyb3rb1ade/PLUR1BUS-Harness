import { signal } from "@preact/signals";
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../view.ts";
import { route, navigate } from "../router.ts";
import { lang, t } from "../i18n.ts";
import { LANDING } from "../nav.ts";
import "../styles/morph.css";

/** Sections map to displayed morph titles in capitals */
const SECTION_NAMES_EN: Record<string, string> = {
  home: "HOME",
  chat: "CHAT",
  projects: "PROJECTS",
  agents: "AGENTS",
  inbox: "INBOX",
  memories: "MEMORIES",
  library: "LIBRARY",
  skills: "SKILLS",
  plugins: "PLUGINS",
  models: "MODELS",
  switchboard: "SWITCHBOARD",
  recurring: "RECURRING",
  approvals: "APPROVALS",
  usage: "USAGE",
  doctor: "STATUS",
  logs: "LOGS",
  settings: "SETTINGS",
  help: "HELP",
  setup: "SETUP",
  breakglass: "BREAK-GLASS",
  media: "MEDIA",
  identities: "IDENTITIES",
};

const SECTION_NAMES_DE: Record<string, string> = {
  home: "STARTSEITE",
  chat: "CHAT",
  projects: "PROJEKTE",
  agents: "AGENTEN",
  inbox: "POSTEINGANG",
  memories: "ERINNERUNGEN",
  library: "BIBLIOTHEK",
  skills: "SKILLS",
  plugins: "PLUGINS",
  models: "MODELLE",
  switchboard: "VERMITTLUNG",
  recurring: "AUFGABEN",
  approvals: "FREIGABEN",
  usage: "NUTZUNG",
  doctor: "STATUS",
  logs: "PROTOKOLLE",
  settings: "EINSTELLUNGEN",
  help: "HILFE",
  setup: "EINRICHTUNG",
  breakglass: "BREAK-GLASS",
  media: "MEDIEN",
  identities: "IDENTITÄTEN",
};

/** Pivot index or letter: find '1' or 'I' or middle */
function splitWord(word: string): { before: string; pivot: string; after: string } {
  if (word === "PLUR1BUS") {
    return { before: "PLUR", pivot: "1", after: "BUS" };
  }
  const oneIdx = word.indexOf("1");
  if (oneIdx >= 0) {
    return { before: word.slice(0, oneIdx), pivot: "1", after: word.slice(oneIdx + 1) };
  }
  const iIdx = word.indexOf("I");
  if (iIdx >= 0) {
    return { before: word.slice(0, iIdx), pivot: "1", after: word.slice(iIdx + 1) };
  }
  // Middle letter
  const mid = Math.floor(word.length / 2);
  return {
    before: word.slice(0, mid),
    pivot: word[mid] || "1",
    after: word.slice(mid + 1),
  };
}

export function V2LogoMorph(): View {
  const r = route.value;
  const currentSection = r.kind === "page" ? r.item.id : (r.kind === "login" ? "login" : "not-found");
  const isHome = currentSection === "home";

  // Determine target word based on language and current section
  const nameMap = lang.value === "de" ? SECTION_NAMES_DE : SECTION_NAMES_EN;
  const targetWord = isHome ? "PLUR1BUS" : (nameMap[currentSection] || "PLUR1BUS");

  const [displayedWord, setDisplayedWord] = useState(targetWord);
  const [collapsed, setCollapsed] = useState(false);
  const prevWordRef = useRef(targetWord);

  useEffect(() => {
    if (prevWordRef.current === targetWord) { setCollapsed(false); return; } // back to the word on show before the collapse finished

    // Check prefers-reduced-motion
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mediaQuery.matches) {
      setDisplayedWord(targetWord);
      prevWordRef.current = targetWord;
      return;
    }

    // Morph animation: collapse into pivot (190ms), switch word, then open (.22s ease-out)
    setCollapsed(true);
    const timer = setTimeout(() => {
      setDisplayedWord(targetWord);
      prevWordRef.current = targetWord;
      setCollapsed(false);
    }, 190);

    return () => clearTimeout(timer);
  }, [targetWord]);

  const { before, pivot, after } = splitWord(displayedWord);

  const handleClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // open in a new tab / window: the href does it
    e.preventDefault();
    // Transform wordmark back into PLUR1BUS and navigate to Home
    setDisplayedWord("PLUR1BUS");
    prevWordRef.current = "PLUR1BUS";
    navigate("/home");
  };

  return h(
    "a",
    {
      class: "wordmark wordmark-morph",
      href: "#/home",
      onClick: handleClick,
      "aria-label": isHome ? t("nav.wordmarkHome") : t("nav.wordmark", { name: displayedWord }),
      "data-collapsed": String(collapsed),
    },
    h("span", { class: `morph-wing wing-before ${collapsed ? "collapsed" : ""}` }, before),
    h("span", { class: "one morph-pivot" }, pivot),
    h("span", { class: `morph-wing wing-after ${collapsed ? "collapsed" : ""}` }, after),
  );
}
