/**
 * The page entry: compose the controller, mount the shell, and — when the page
 * was opened with a `?binding=` address — ask for the connection once.
 *
 * The controller is created here and never inside a component, so a re-render
 * is never a reconnection and StrictMode's double render cannot open two
 * connections. Connecting is a deliberate act: the URL form is the shell's own
 * startup convenience, and every other connection comes from the panel's
 * buttons.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { connectHttpChannel } from "../client/http-channel.js";
import { App } from "./App.js";
import { createShellController } from "./controller.js";
import { selectionStorage } from "./selection.js";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("the shell page has no #root element");
}

const initialBinding = new URLSearchParams(window.location.search).get("binding");
const controller = createShellController({
  storage: selectionStorage(window.sessionStorage),
  initialBinding,
  connector: (origin: string) => connectHttpChannel({ origin }),
});

createRoot(container).render(
  <StrictMode>
    <App controller={controller} />
  </StrictMode>,
);

if (initialBinding !== null) {
  void controller.connect();
}
