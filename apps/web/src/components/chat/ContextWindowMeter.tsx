import { Button } from "../ui/button";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";
import { Minimize2Icon } from "lucide-react";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const { usage, modelDisplayName, onCompact, compactDisabled, compactDisabledReason } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7 rounded-full hover:text-muted-foreground data-pressed:text-muted-foreground"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-72 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-secondary-label text-[11px] tabular-nums">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-[11px] tabular-nums">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {usage.categories ? (
            <div className="flex flex-col gap-1 border-t border-border/40 pt-2 text-[11px]">
              <div className="font-medium text-muted-foreground text-[10px] uppercase tracking-wider mb-0.5">
                Token usage by category
              </div>
              <div className="flex flex-col gap-1">
                {usage.categories.userMessages != null && usage.categories.userMessages > 0 ? (
                  <div className="flex items-center justify-between text-secondary-label">
                    <span className="flex items-center gap-1.5">
                      <span className="size-1.5 rounded-full bg-sky-500 inline-block" />
                      User messages
                    </span>
                    <span className="tabular-nums font-mono">
                      {formatContextWindowTokens(usage.categories.userMessages)}
                      {usage.maxTokens
                        ? ` (${((usage.categories.userMessages / usage.maxTokens) * 100).toFixed(1)}%)`
                        : ""}
                    </span>
                  </div>
                ) : null}
                {usage.categories.agentResponses != null && usage.categories.agentResponses > 0 ? (
                  <div className="flex items-center justify-between text-secondary-label">
                    <span className="flex items-center gap-1.5">
                      <span className="size-1.5 rounded-full bg-emerald-500 inline-block" />
                      Agent responses
                    </span>
                    <span className="tabular-nums font-mono">
                      {formatContextWindowTokens(usage.categories.agentResponses)}
                      {usage.maxTokens
                        ? ` (${((usage.categories.agentResponses / usage.maxTokens) * 100).toFixed(1)}%)`
                        : ""}
                    </span>
                  </div>
                ) : null}
                {usage.categories.toolCalls != null && usage.categories.toolCalls > 0 ? (
                  <div className="flex items-center justify-between text-secondary-label">
                    <span className="flex items-center gap-1.5">
                      <span className="size-1.5 rounded-full bg-purple-500 inline-block" />
                      Tool calls
                    </span>
                    <span className="tabular-nums font-mono">
                      {formatContextWindowTokens(usage.categories.toolCalls)}
                      {usage.maxTokens
                        ? ` (${((usage.categories.toolCalls / usage.maxTokens) * 100).toFixed(1)}%)`
                        : ""}
                    </span>
                  </div>
                ) : null}
                {usage.categories.systemPrompt != null && usage.categories.systemPrompt > 0 ? (
                  <div className="flex items-center justify-between text-secondary-label">
                    <span className="flex items-center gap-1.5">
                      <span className="size-1.5 rounded-full bg-amber-500 inline-block" />
                      System prompt
                    </span>
                    <span className="tabular-nums font-mono">
                      {formatContextWindowTokens(usage.categories.systemPrompt)}
                      {usage.maxTokens
                        ? ` (${((usage.categories.systemPrompt / usage.maxTokens) * 100).toFixed(1)}%)`
                        : ""}
                    </span>
                  </div>
                ) : null}
                {usage.categories.systemTools != null && usage.categories.systemTools > 0 ? (
                  <div className="flex items-center justify-between text-secondary-label">
                    <span className="flex items-center gap-1.5">
                      <span className="size-1.5 rounded-full bg-cyan-500 inline-block" />
                      System tools
                    </span>
                    <span className="tabular-nums font-mono">
                      {formatContextWindowTokens(usage.categories.systemTools)}
                      {usage.maxTokens
                        ? ` (${((usage.categories.systemTools / usage.maxTokens) * 100).toFixed(1)}%)`
                        : ""}
                    </span>
                  </div>
                ) : null}
                {usage.categories.skills != null && usage.categories.skills > 0 ? (
                  <div className="flex items-center justify-between text-secondary-label">
                    <span className="flex items-center gap-1.5">
                      <span className="size-1.5 rounded-full bg-indigo-500 inline-block" />
                      Skills
                    </span>
                    <span className="tabular-nums font-mono">
                      {formatContextWindowTokens(usage.categories.skills)}
                      {usage.maxTokens
                        ? ` (${((usage.categories.skills / usage.maxTokens) * 100).toFixed(1)}%)`
                        : ""}
                    </span>
                  </div>
                ) : null}
                {usage.categories.subagents != null && usage.categories.subagents > 0 ? (
                  <div className="flex items-center justify-between text-secondary-label">
                    <span className="flex items-center gap-1.5">
                      <span className="size-1.5 rounded-full bg-pink-500 inline-block" />
                      Subagents
                    </span>
                    <span className="tabular-nums font-mono">
                      {formatContextWindowTokens(usage.categories.subagents)}
                      {usage.maxTokens
                        ? ` (${((usage.categories.subagents / usage.maxTokens) * 100).toFixed(1)}%)`
                        : ""}
                    </span>
                  </div>
                ) : null}
                {usage.categories.checkpointBuffer != null &&
                usage.categories.checkpointBuffer > 0 ? (
                  <div className="flex items-center justify-between text-secondary-label">
                    <span className="flex items-center gap-1.5">
                      <span className="size-1.5 rounded-full bg-zinc-500 inline-block" />
                      Checkpoint buffer
                    </span>
                    <span className="tabular-nums font-mono">
                      {formatContextWindowTokens(usage.categories.checkpointBuffer)}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          ) : (usage.inputTokens != null && usage.inputTokens > 0) ||
            (usage.cachedInputTokens != null && usage.cachedInputTokens > 0) ||
            (usage.outputTokens != null && usage.outputTokens > 0) ||
            (usage.reasoningOutputTokens != null && usage.reasoningOutputTokens > 0) ? (
            <div className="flex flex-col gap-1 border-t border-border/40 pt-2 text-[11px]">
              <div className="font-medium text-muted-foreground text-[10px] uppercase tracking-wider mb-0.5">
                Token breakdown
              </div>
              {usage.cachedInputTokens != null && usage.cachedInputTokens > 0 ? (
                <div className="flex items-center justify-between text-secondary-label">
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-amber-500 inline-block" />
                    Cached prompt
                  </span>
                  <span className="tabular-nums font-mono">
                    {formatContextWindowTokens(usage.cachedInputTokens)}
                    {usage.maxTokens
                      ? ` (${((usage.cachedInputTokens / usage.maxTokens) * 100).toFixed(1)}%)`
                      : ""}
                  </span>
                </div>
              ) : null}
              {usage.inputTokens != null && usage.inputTokens > 0 ? (
                <div className="flex items-center justify-between text-secondary-label">
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-sky-500 inline-block" />
                    New input
                  </span>
                  <span className="tabular-nums font-mono">
                    {formatContextWindowTokens(usage.inputTokens)}
                    {usage.maxTokens
                      ? ` (${((usage.inputTokens / usage.maxTokens) * 100).toFixed(1)}%)`
                      : ""}
                  </span>
                </div>
              ) : null}
              {usage.outputTokens != null && usage.outputTokens > 0 ? (
                <div className="flex items-center justify-between text-secondary-label">
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-emerald-500 inline-block" />
                    Agent output
                  </span>
                  <span className="tabular-nums font-mono">
                    {formatContextWindowTokens(usage.outputTokens)}
                    {usage.maxTokens
                      ? ` (${((usage.outputTokens / usage.maxTokens) * 100).toFixed(1)}%)`
                      : ""}
                  </span>
                </div>
              ) : null}
              {usage.reasoningOutputTokens != null && usage.reasoningOutputTokens > 0 ? (
                <div className="flex items-center justify-between text-secondary-label">
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-purple-500 inline-block" />
                    Thinking tokens
                  </span>
                  <span className="tabular-nums font-mono">
                    {formatContextWindowTokens(usage.reasoningOutputTokens)}
                    {usage.maxTokens
                      ? ` (${((usage.reasoningOutputTokens / usage.maxTokens) * 100).toFixed(1)}%)`
                      : ""}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4 border-t border-border/30 pt-1.5">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-[11px] font-medium">
              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
            </div>
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                Compact context
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-[11px]">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
