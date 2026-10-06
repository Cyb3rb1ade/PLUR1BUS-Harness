import "@preact/signals";
import { h, render } from "preact";
import { App, bindApp } from "./app.ts";
import { initSession } from "./session.ts";
import { bindTheme } from "./theme.ts";

bindTheme();
bindApp();
const root = document.getElementById("app");
if (root) render(h(App, {}), root);
void initSession();
