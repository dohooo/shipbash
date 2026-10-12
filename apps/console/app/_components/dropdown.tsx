"use client";

import {
  Children,
  cloneElement,
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type MouseEventHandler,
  type ReactElement,
} from "react";

interface DropdownContextValue {
  contentId: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

const DropdownContext = createContext<DropdownContextValue | null>(null);

function useDropdown(): DropdownContextValue {
  const value = use(DropdownContext);
  if (!value) throw new Error("Dropdown components must be used inside Dropdown.Root.");
  return value;
}

function DropdownRoot({
  children,
  className,
  onOpenChange,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "onChange"> & {
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setInternalOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentId = useId();
  const setOpen = useCallback((nextOpen: boolean) => {
    setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }, [onOpenChange]);

  // With Cache Components a route you navigate away from is hidden, not
  // unmounted, so a menu left open is still open when you come back to it —
  // covering the content you returned to read. Close it as the route is hidden.
  // The latest setter is held in a ref so the deps stay empty: callers pass
  // inline onOpenChange handlers, and re-running this on every render would
  // close the menu in the same tick it was opened.
  const setOpenRef = useRef(setOpen);
  useEffect(() => {
    setOpenRef.current = setOpen;
  }, [setOpen]);
  useLayoutEffect(() => () => {
    setOpenRef.current(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && !event.composedPath().includes(root)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, setOpen]);

  return (
    <DropdownContext value={{ contentId, open, setOpen, triggerRef }}>
      <div {...props} className={["dropdown-root", className].filter(Boolean).join(" ")} data-open={open ? "true" : "false"} ref={rootRef}>
        {children}
      </div>
    </DropdownContext>
  );
}

function DropdownTrigger({
  children,
  className,
  onClick,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { contentId, open, setOpen, triggerRef } = useDropdown();
  return (
    <button
      {...props}
      aria-controls={contentId}
      aria-expanded={open}
      className={["dropdown-trigger", className].filter(Boolean).join(" ")}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) setOpen(!open);
      }}
      ref={triggerRef}
      type={type}
    >
      {children}
    </button>
  );
}

function DropdownContent({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const { contentId, open } = useDropdown();
  if (!open) return null;
  return (
    <div {...props} className={["dropdown-content", className].filter(Boolean).join(" ")} id={contentId}>
      {children}
    </div>
  );
}

function DropdownClose({ children }: { children: ReactElement<{ onClick?: MouseEventHandler<HTMLElement> }> }) {
  const { setOpen } = useDropdown();
  const child = Children.only(children);
  return cloneElement(child, {
    onClick: (event) => {
      child.props.onClick?.(event);
      if (!event.defaultPrevented) setOpen(false);
    },
  });
}

function DropdownSeparator({ className, ...props }: HTMLAttributes<HTMLHRElement>) {
  return <hr {...props} className={["dropdown-separator", className].filter(Boolean).join(" ")} />;
}

export const Dropdown = {
  Root: DropdownRoot,
  Trigger: DropdownTrigger,
  Content: DropdownContent,
  Close: DropdownClose,
  Separator: DropdownSeparator,
};
