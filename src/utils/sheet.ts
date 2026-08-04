import { bindSwipeDismiss } from './overlayGestures';

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

  const scrollContainer =
    options.scrollContainer ?? (document.getElementById(`${id}Scroll`) as HTMLElement | null);

  let open = false;

  function openSheet(): void {
    if (open) return;
    open = true;
    panel.style.transform = '';
    panel.classList.add('visible');
    backdrop.classList.add('visible');
    backdrop.style.opacity = '';
    document.body.classList.add(bodyClass);
    onOpen?.();
  }

  function closeSheet(): void {
    if (!open) return;
    open = false;
    panel.classList.remove('visible');
    backdrop.classList.remove('visible');
    backdrop.style.opacity = '';
    document.body.classList.remove(bodyClass);
    // Let the CSS transition animate from wherever a drag left the panel.
    panel.style.transform = '';
    onClose?.();
  }

  backdrop.addEventListener('click', closeSheet);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) closeSheet();
  });

  if (scrollContainer) {
    bindSwipeDismiss({
      panel,
      scrollContainer,
      backdrop,
      onDismiss: closeSheet,
    });
  }

  return {
    open: openSheet,
    close: closeSheet,
    isOpen: () => open,
    panel,
    backdrop,
  };
}
