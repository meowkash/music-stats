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

    // Guarantee the off-screen frame is committed before .visible flips the
    // transform — otherwise Safari can skip the entrance transition entirely,
    // which reads as a delayed "pop in".
    panel.style.transform = '';
    backdrop.style.opacity = '';
    panel.classList.remove('visible');
    backdrop.classList.remove('visible');
    void panel.offsetWidth;

    panel.classList.add('visible');
    backdrop.classList.add('visible');
    document.body.classList.add(bodyClass);

    // Fire content hooks after the slide has started.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => onOpen?.());
    });
  }

  function closeSheet(): void {
    if (!open) return;
    open = false;
    panel.classList.remove('visible');
    backdrop.classList.remove('visible');
    document.body.classList.remove(bodyClass);
    // Keep any in-flight drag offset so dismiss continues from the finger.
    // Clearing after the transition would be nicer, but transform '' while
    // .visible is gone targets translateY(100%) and CSS animates from here.
    panel.style.transform = '';
    backdrop.style.opacity = '';
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
