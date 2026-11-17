// Adds a Copy button next to every [data-copy] block. Without this script the text is still selectable.
for (const el of document.querySelectorAll("[data-copy]")) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn btn-secondary btn-sm copy-btn";
  b.textContent = "Copy";
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(el.textContent.trim());
      b.textContent = "Copied";
    } catch {
      b.textContent = "Press Ctrl+C";
      getSelection().selectAllChildren(el);
    }
    setTimeout(() => (b.textContent = "Copy"), 2000);
  });
  el.after(b);
}
