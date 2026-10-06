"use client";
import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { Slot } from "@radix-ui/react-slot";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import {
  AlertTriangle,
  ArrowUpRight,
  Ban,
  Check,
  Eye,
  OctagonAlert,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...values: Parameters<typeof clsx>) {
  return twMerge(clsx(values));
}
export const Button = forwardRef<
  HTMLButtonElement,
  ComponentProps<"button"> & {
    variant?: "primary" | "secondary" | "ghost" | "danger";
    asChild?: boolean;
  }
>(function Button(
  { className, variant = "secondary", asChild, ...props },
  ref,
) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      ref={ref}
      className={cn("button", `button-${variant}`, className)}
      {...props}
    />
  );
});
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <small className="field-hint">{hint}</small>}
    </label>
  );
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="modal-overlay" />
        <DialogPrimitive.Content className={cn("modal", wide && "modal-wide")}>
          <div className="modal-heading">
            <div className="modal-heading-copy">
              <DialogPrimitive.Title className="modal-title">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description
                className={description ? "modal-description" : "sr-only"}
              >
                {description || title}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <Button
                variant="ghost"
                className="icon-button modal-close"
                aria-label="Close dialog"
              >
                <X size={19} />
              </Button>
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
export function Switch({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <SwitchPrimitive.Root
      className="switch"
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
    >
      <SwitchPrimitive.Thumb className="switch-thumb" />
    </SwitchPrimitive.Root>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-symbol" aria-hidden="true">
        <ArrowUpRight size={24} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div className="page-heading-copy">
        {eyebrow && (
          <div className="eyebrow page-eyebrow">
            <span className="eyebrow-rule" aria-hidden="true" />
            {eyebrow}
          </div>
        )}
        <div className="page-title-row">
          <h1>{title}</h1>
        </div>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </div>
  );
}

const riskPresentation = {
  safe: { label: "On track", icon: Check },
  attention: { label: "Needs attention", icon: Eye },
  high: { label: "High risk", icon: AlertTriangle },
  critical: { label: "Critical", icon: OctagonAlert },
  impossible: { label: "Impossible", icon: Ban },
};
export function RiskBadge({ level, score }: { level: string; score?: number }) {
  const presentation = riskPresentation[level as keyof typeof riskPresentation];
  const Icon = presentation?.icon || AlertTriangle;
  return (
    <span className={cn("risk-badge", `risk-${level}`)}>
      <Icon
        className="risk-symbol"
        size={12}
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <span className="risk-label">
        {presentation?.label || level.replaceAll("_", " ")}
      </span>
      {score !== undefined && (
        <span className="risk-score">
          <span className="sr-only">Risk score </span>
          {Math.round(score)}
        </span>
      )}
    </span>
  );
}
