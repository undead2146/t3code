import { memo, useCallback, useEffect, useState } from "react";
import { AlertTriangleIcon, CheckIcon, CopyIcon, CornerDownLeftIcon, XIcon } from "lucide-react";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

export interface BtwState {
  readonly query: string;
  readonly status: "loading" | "done" | "error";
  readonly text?: string | undefined;
  readonly error?: string | undefined;
}

export interface BtwOverlayHUDProps {
  readonly state: BtwState;
  readonly onDismiss: () => void;
  readonly onInsertToComposer?: ((text: string) => void) | undefined;
  readonly cwd?: string | null | undefined;
}

export const BtwOverlayHUD = memo(function BtwOverlayHUD({
  state,
  onDismiss,
  onInsertToComposer,
  cwd,
}: BtwOverlayHUDProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onDismiss();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onDismiss]);

  const handleCopy = useCallback(async () => {
    if (!state.text) return;
    try {
      await navigator.clipboard.writeText(state.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard write failure
    }
  }, [state.text]);

  const handleInsert = useCallback(() => {
    if (state.text && onInsertToComposer) {
      onInsertToComposer(state.text);
    }
  }, [state.text, onInsertToComposer]);

  return (
    <div
      role="region"
      aria-label="By the way ephemeral response"
      data-slot="btw-overlay-hud"
      className="relative mb-3 flex flex-col overflow-hidden rounded-2xl border border-border/80 bg-card/95 text-card-foreground shadow-2xl backdrop-blur-md transition-all duration-200"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex items-center rounded-md bg-blue-500/15 px-2 py-0.5 text-xs font-semibold text-blue-500 dark:text-blue-400">
            /btw
          </span>
          <span className="truncate text-xs font-medium text-foreground/85" title={state.query}>
            {state.query}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2 pl-2">
          <span className="select-none text-[11px] text-muted-foreground/70">Esc to dismiss</span>
          <Button
            variant="ghost"
            size="xs"
            onClick={onDismiss}
            aria-label="Dismiss /btw"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Body */}
      {state.status === "loading" ? (
        <div className="flex items-center gap-2.5 px-4 py-6 text-xs text-muted-foreground">
          <Spinner className="size-4 animate-spin text-blue-500" />
          <span>Consulting Antigravity with active conversation model...</span>
        </div>
      ) : state.status === "error" ? (
        <div className="flex items-start gap-2.5 px-4 py-4 text-xs text-destructive">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
          <span className="break-words">{state.error ?? "Failed to execute side-query."}</span>
        </div>
      ) : (
        <div className="max-h-[50vh] overflow-y-auto px-4 py-3 text-sm leading-relaxed">
          <ChatMarkdown cwd={cwd ?? undefined} text={state.text ?? ""} />
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/20 px-3 py-2">
        {state.status === "done" && state.text ? (
          <>
            <Button
              size="xs"
              variant="ghost"
              onClick={handleCopy}
              className="gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {copied ? (
                <CheckIcon className="size-3 text-green-500" />
              ) : (
                <CopyIcon className="size-3" />
              )}
              {copied ? "Copied" : "Copy text"}
            </Button>
            {onInsertToComposer ? (
              <Button
                size="xs"
                variant="outline"
                onClick={handleInsert}
                className="gap-1.5 text-xs"
              >
                <CornerDownLeftIcon className="size-3" />
                Insert into draft
              </Button>
            ) : null}
          </>
        ) : null}
        <Button
          size="xs"
          variant={state.status === "error" ? "destructive" : "secondary"}
          onClick={onDismiss}
          className="text-xs"
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
});
