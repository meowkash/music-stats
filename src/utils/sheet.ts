import { bindSwipeDismiss } from './overlayGestures';
import { setOverlayOpen } from './overlayState';

export interface SheetOptions {
  /** Element id prefix passed to the BottomSheet component. */
  id: string;
  /** Element that owns the vertical scroll inside the sheet. */
  scrollContainer?: HTMLElement | null;
  /** Class toggled on <body> while the sheet is open. */
  bodyClass: string;
  onOpen?: () => void;
  onClose?: () => void;
}

export interface SheetController {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  panel: HTMLElement;
  backdrop: HTMLElement;
}

/**
 * Wires the shared open/close, backdrop, Escape and swipe-to-dismiss behaviour
 * that every sheet in the app should share.
 */
export function createSheet(options: SheetOptions): SheetController | null {
  const { id, bodyClass, onOpen, onClose } = options;

  const panel = document.getElementById(`${id}Panel`);
  const backdrop = document.getElementById(`${id}Backdrop`);
  if (!panel || !backdrop) return null;
  const panelEl = panel;
  const backdropEl = backdrop;

  const scrollContainer =
    options.scrollContainer ?? (document.getElementById(`${id}Scroll`) as HTMLElement | null);

  let open = false;

  function openSheet(): void {
    if (open) return;
    open = true;

    panelEl.style.transform = '';
    backdropEl.style.opacity = '';
    panelEl.classList.remove('visible');
    backdropEl.classList.remove('visible');
    void panelEl.offsetWidth;

    panelEl.classList.add('visible');
    backdropEl.classList.add('visible');
    document.body.classList.add(bodyClass);
    setOverlayOpen(`sheet:${bodyClass}`, true);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => onOpen?.());
    });
  }

  function closeSheet(): void {
    if (!open) return;
    open = false;
    panelEl.classList.remove('visible');
    backdropEl.classList.remove('visible');
    document.body.classList.remove(bodyClass);
    setOverlayOpen(`sheet:${bodyClass}`, false);
    panelEl.style.transform = '';
    backdropEl.style.opacity = '';
    onClose?.();
  }

  backdropEl.addEventListener('click', closeSheet);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) closeSheet();
  });

  if (scrollContainer) {
    bindSwipeDismiss({
      panel: panelEl,
      scrollContainer,
      backdrop: backdropEl,
      onDismiss: closeSheet,
    });
  }

  return {
    open: openSheet,
    close: closeSheet,
    isOpen: () => open,
    panel: panelEl,
    backdrop: backdropEl,
  };
}
