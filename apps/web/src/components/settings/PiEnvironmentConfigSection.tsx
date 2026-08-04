"use client";

import {
  type EnvironmentId,
  type PiSettingsFileCurated,
  type PiSettingsFileSnapshot,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { cn } from "~/lib/utils";

/**
 * Pi's thinking-tier enum, matching what pi accepts for
 * `defaultThinkingLevel` in settings.json (see the pi adapter's spawn
 * args). Empty = unset (key omitted from the file).
 */
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function prettyPrintJson(content: string): string {
  if (content.trim().length === 0) {
    return "";
  }
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function validateJson(content: string): string | null {
  if (content.trim().length === 0) {
    return "Must contain valid JSON.";
  }
  try {
    JSON.parse(content);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid JSON.";
  }
}

function toCuratedInput(curated: PiSettingsFileCurated): {
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinkingLevel: string | null;
} {
  return {
    defaultProvider: curated.defaultProvider?.trim() || null,
    defaultModel: curated.defaultModel?.trim() || null,
    defaultThinkingLevel: curated.defaultThinkingLevel?.trim() || null,
  };
}

/**
 * The "Pi environment config" editor inside a pi provider instance card.
 * Edits the single global `<agentDir>/settings.json` (shared by all pi
 * instances on this machine) via the server's settings-file RPCs: a few
 * curated fields plus a raw-JSON whole-file editor, with two-way sync from
 * the server's post-save read-back. Mobile has no provider settings
 * surface, so this is web/desktop only.
 */
export function PiEnvironmentConfigSection(props: {
  environmentId: EnvironmentId | null;
  instanceId: string;
}) {
  const getSettingsFile = useAtomCommand(serverEnvironment.piGetSettingsFile, {
    reportFailure: false,
  });
  const updateSettingsFile = useAtomCommand(serverEnvironment.piUpdateSettingsFile, {
    reportFailure: false,
  });

  const [isOpen, setIsOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<PiSettingsFileSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const loadSnapshot = useCallback(async () => {
    if (!props.environmentId || hasLoadedRef.current) {
      return;
    }
    hasLoadedRef.current = true;
    setIsLoading(true);
    setLoadError(null);
    const result = await getSettingsFile({
      environmentId: props.environmentId,
      input: {},
    });
    setIsLoading(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setLoadError(
          failure instanceof Error ? failure.message : "Could not read the pi settings file.",
        );
      }
      hasLoadedRef.current = false;
      return;
    }
    setSnapshot(result.value);
    setSaveError(null);
  }, [getSettingsFile, props.environmentId]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    void loadSnapshot();
  }, [isOpen, loadSnapshot]);

  const applySavedSnapshot = useCallback((next: PiSettingsFileSnapshot) => {
    setSnapshot(next);
    setRawDraft(null);
    setSaveError(null);
  }, []);

  const saveCurated = useCallback(
    async (curated: PiSettingsFileCurated) => {
      if (!props.environmentId || isSaving) {
        return;
      }
      setIsSaving(true);
      setSaveError(null);
      try {
        const result = await updateSettingsFile({
          environmentId: props.environmentId,
          input: { mode: "curated", curated: toCuratedInput(curated) },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            setSaveError(
              failure instanceof Error ? failure.message : "Could not save the pi settings file.",
            );
          }
          return;
        }
        applySavedSnapshot(result.value);
        toastManager.add({
          type: "success",
          title: "Pi settings saved",
          description: "Applies to new pi sessions.",
        });
      } finally {
        setIsSaving(false);
      }
    },
    [applySavedSnapshot, isSaving, props.environmentId, updateSettingsFile],
  );

  const saveRaw = useCallback(async () => {
    if (!props.environmentId || isSaving || rawDraft === null) {
      return;
    }
    const error = validateJson(rawDraft);
    if (error !== null) {
      setSaveError(error);
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      const result = await updateSettingsFile({
        environmentId: props.environmentId,
        input: { mode: "raw", content: rawDraft },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setSaveError(
            failure instanceof Error ? failure.message : "Could not save the pi settings file.",
          );
        }
        return;
      }
      applySavedSnapshot(result.value);
      toastManager.add({
        type: "success",
        title: "Pi settings saved",
        description: "Applies to new pi sessions.",
      });
    } finally {
      setIsSaving(false);
    }
  }, [applySavedSnapshot, isSaving, props.environmentId, rawDraft, updateSettingsFile]);

  const rawValue = rawDraft ?? (snapshot ? prettyPrintJson(snapshot.content) : "");
  const rawError = rawDraft !== null ? validateJson(rawDraft) : null;
  const rawDirty = rawDraft !== null;
  const rawValid = rawDraft !== null && rawError === null;
  const curated = snapshot?.curated;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2.5 text-left">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs font-medium text-foreground">Pi environment config</span>
          <span className="text-xs text-muted-foreground">
            {snapshot?.path ?? "~/.pi/agent/settings.json"} — global, shared by all pi instances on
            this machine
          </span>
        </span>
        <span
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            isOpen && "rotate-180",
            "text-muted-foreground/70",
          )}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-4 pt-3">
          <Alert className="py-2.5">
            <AlertDescription className="text-xs">
              Applies to new pi sessions — running sessions keep their current settings.
            </AlertDescription>
          </Alert>

          {loadError ? (
            <Alert variant="error">
              <AlertDescription className="text-xs">{loadError}</AlertDescription>
            </Alert>
          ) : null}
          {saveError ? (
            <Alert variant="error">
              <AlertDescription className="text-xs">{saveError}</AlertDescription>
            </Alert>
          ) : null}

          {snapshot?.malformed ? (
            <Alert variant="warning">
              <AlertDescription className="text-xs">
                pi can't read this file until it's fixed — it runs on defaults. Fix the JSON below
                and save.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-3">
            <div>
              <label className="block">
                <span className="text-xs font-medium text-foreground">Default thinking level</span>
                <Select
                  value={curated?.defaultThinkingLevel ?? ""}
                  disabled={isLoading || isSaving || !props.environmentId}
                  onValueChange={(value) => {
                    if (curated) {
                      void saveCurated({
                        ...curated,
                        defaultThinkingLevel: value,
                      });
                    }
                  }}
                >
                  <SelectTrigger className="mt-1.5 w-full" aria-label="Default thinking level">
                    <SelectValue placeholder="Unset" />
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    <SelectItem value="" hideIndicator className="min-w-56 py-2">
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-foreground">Unset</span>
                        <span className="block text-xs text-muted-foreground">
                          Omit from settings.json — pi's own default applies.
                        </span>
                      </div>
                    </SelectItem>
                    {PI_THINKING_LEVELS.map((level) => (
                      <SelectItem key={level} value={level} hideIndicator className="min-w-56 py-2">
                        <div className="min-w-0 flex-1">
                          <span className="font-medium text-foreground capitalize">{level}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
            </div>

            <div>
              <label className="block">
                <span className="text-xs font-medium text-foreground">Default provider</span>
                <DraftInput
                  className="mt-1.5"
                  value={curated?.defaultProvider ?? ""}
                  disabled={isLoading || isSaving || !props.environmentId}
                  onCommit={(value) => {
                    if (curated) {
                      void saveCurated({ ...curated, defaultProvider: value });
                    }
                  }}
                  placeholder="e.g. anthropic"
                  spellCheck={false}
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  Provider used when a thread doesn't name one. Empty = unset.
                </span>
              </label>
            </div>

            <div>
              <label className="block">
                <span className="text-xs font-medium text-foreground">Default model</span>
                <DraftInput
                  className="mt-1.5"
                  value={curated?.defaultModel ?? ""}
                  disabled={isLoading || isSaving || !props.environmentId}
                  onCommit={(value) => {
                    if (curated) {
                      void saveCurated({ ...curated, defaultModel: value });
                    }
                  }}
                  placeholder="e.g. claude-sonnet-4-6"
                  spellCheck={false}
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  Model used when a thread doesn't name one. Empty = unset.
                </span>
              </label>
            </div>
          </div>

          <div>
            <span className="text-xs font-medium text-foreground">Raw JSON</span>
            <Textarea
              className="mt-1.5 min-h-40 resize-y font-mono text-xs leading-relaxed"
              value={rawValue}
              disabled={isLoading || isSaving || !props.environmentId}
              onChange={(event) => {
                setRawDraft(event.target.value);
                setSaveError(null);
              }}
              placeholder="{}"
              spellCheck={false}
            />
            {rawError ? (
              <p className="mt-1 text-xs text-destructive">{rawError}</p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                Whole-file editor — unknown and pi-managed keys are preserved on curated-field
                saves. Must be strict JSON.
              </p>
            )}
            <Button
              size="sm"
              className="mt-2"
              disabled={!rawValid || !rawDirty || isSaving || !props.environmentId}
              onClick={() => void saveRaw()}
            >
              Save raw JSON
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
