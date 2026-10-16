/** Unfolds a long notebook cell (notebook.ts folds it) when its button is clicked. */
export function listenForUnfold() {
  document.addEventListener("click", (event) => {
    const button = (event.target as Element).closest?.(".nb-unfold");
    if (!button) return;
    button.parentElement?.classList.remove("nb-folded");
    button.remove();
  });
}
