"use client";
import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
export interface ErrorNoticeProps {
  title?: string;
  message: string;
  guidance?: string;
  action?: ReactNode;
}

export function ErrorNotice({
  title = "Something needs attention",
  message,
  guidance,
  action,
}: ErrorNoticeProps) {
  const detailed = !!guidance || message.length > 240;
  return (
    <div className="error-notice" role="alert">
      <AlertCircle size={19} aria-hidden="true" />
      <div className="error-notice-content">
        <strong>{title}</strong>
        <p>
          {guidance ||
            (detailed
              ? "The operation couldn't finish. Review the details below before trying again."
              : message)}
        </p>
        {detailed && (
          <details>
            <summary>View details</summary>
            <p className="error-notice-details">{message}</p>
          </details>
        )}
        {action && <div className="error-notice-action">{action}</div>}
      </div>
    </div>
  );
}
