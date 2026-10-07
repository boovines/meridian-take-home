"use client";
import { useEffect, useRef, type ReactNode } from "react";
export function Dialog({
  children,
  labelledBy,
  onClose,
}: {
  children: ReactNode;
  labelledBy: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={labelledBy}
      onCancel={onClose}
    >
      {children}
    </dialog>
  );
}
