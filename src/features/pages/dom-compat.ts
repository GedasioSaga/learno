/**
 * `showPopover`/`hidePopover` (Popover API) e `HTMLDialogElement.showModal`
 * rodam sem problema no WebView2 real que o Tauri usa, mas o jsdom dos testes
 * de componente não os implementa — chamar direto quebraria todo teste que
 * passa por um popover ou diálogo. Checar a existência do método antes de
 * chamar é barato e verdadeiro nos dois ambientes, então fica aqui em vez de
 * um mock global de jsdom.
 */
export function hidePopoverSafely(element: HTMLElement | null): void {
  if (element && typeof element.hidePopover === "function") {
    element.hidePopover();
  }
}
