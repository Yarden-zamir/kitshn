import { render } from "preact";
import { App } from "./App.tsx";
import { connect } from "./store.ts";
import "./styles.css";
import { startTheme } from "./theme.ts";

const root = document.getElementById("app");
if (!root) throw new Error("The page has no #app element.");
// The two guide pages show fixtures only, so they never open the live connection; each loads as its own chunk.
if (location.pathname === "/neo-brutalism") {
  void import("./StyleGuide.tsx").then(({ StyleGuide }) => render(<StyleGuide />, root));
} else if (location.pathname === "/concepts") {
  void import("./Concepts.tsx").then(({ Concepts }) => render(<Concepts />, root));
} else {
  startTheme();
  connect();
  render(<App />, root);
}
