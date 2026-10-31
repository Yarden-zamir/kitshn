// The install page: tick a step and it stays ticked on this device, the bar counts what is done, and each code block has
// a copy button. Plain script, no build, like the rest of the site.
const KEY = "kitshn.install.done";
const boxes = [...document.querySelectorAll("[data-step]")];
const required = boxes.filter((box) => !("optional" in box.dataset));
const text = document.querySelector(".progress-text");
const bar = document.querySelector(".progress-bar i");

const load = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
  } catch {
    return new Set();
  }
};
const done = load();

function paint() {
  for (const box of boxes) {
    box.checked = done.has(box.dataset.step);
    box.closest("li").classList.toggle("is-done", box.checked);
  }
  const count = required.filter((box) => box.checked).length;
  text.textContent =
    count === required.length ? "All done. Your first app is live." : `${count} of ${required.length} done`;
  bar.style.width = `${(count / required.length) * 100}%`;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify([...done]));
  } catch {
    // A browser that keeps no storage still ticks the steps for this visit.
  }
  paint();
}

for (const box of boxes) {
  box.addEventListener("change", () => {
    if (box.checked) done.add(box.dataset.step);
    else done.delete(box.dataset.step);
    save();
  });
}
document.querySelector(".progress-reset").addEventListener("click", () => {
  done.clear();
  save();
});
paint();

for (const button of document.querySelectorAll(".copy")) {
  let timer = 0;
  button.addEventListener("click", async () => {
    // A command split with backslashes is copied as one line, so no line ending can break it in the shell.
    const code = button.parentElement.querySelector("code").textContent.replace(/\s*\\\r?\n\s*/g, " ");
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = "Copied ✓";
    } catch {
      button.textContent = "Press Ctrl+C";
      getSelection().selectAllChildren(button.parentElement.querySelector("code"));
    }
    clearTimeout(timer);
    timer = setTimeout(() => (button.textContent = "Copy"), 2000);
  });
}
