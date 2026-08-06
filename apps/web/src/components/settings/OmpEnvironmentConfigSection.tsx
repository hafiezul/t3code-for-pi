"use client";

import {
  type EnvironmentId,
  type OmpSettingsFileCurated,
  type OmpSettingsFileSnapshot,
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import { cn } from "~/lib/utils";

import {
  modelRolesDraftError,
  OMP_THINKING_LEVEL_OPTIONS,
  toCuratedInput,
} from "./OmpEnvironmentConfigSection.logic";

type EditorTab = "curated" | "raw";

/**
 * The body of the OMP config editor — everything inside the collapsible.
 * Kept as a separate presentational component so the form can be rendered
 * (and tested) without the atom/RPC plumbing of the container.
 */
export function OmpEnvironmentConfigBody(props: {
  environmentId: EnvironmentId | null;
  snapshot: OmpSettingsFileSnapshot | null;
  isLoading: boolean;
  isSaving: boolean;
  loadError: string | null;
  saveError: string | null;
  /** Which tab starts active; defaults to "curated". */
  initialTab?: EditorTab;
  onSaveCurated: (curated: OmpSettingsFileCurated) => void;
  onSaveRaw: (content: string) => void;
}) {
  const [tab, setTab] = useState<EditorTab>(props.initialTab ?? "curated");
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  const [modelRolesDraft, setModelRolesDraft] = useState<string | null>(null);

  // New read-back from the server resets the drafts so the form re-renders
  // from the server's view (two-way sync).
  useEffect(() => {
    setRawDraft(null);
    setModelRolesDraft(null);
  }, [props.snapshot]);

  const disabled = props.isLoading || props.isSaving || !props.environmentId;
  const curated = props.snapshot?.curated;

  const modelRolesValue = modelRolesDraft ?? curated?.modelRoles ?? "";
  const modelRolesDirty =
    modelRolesDraft !== null && modelRolesDraft !== (curated?.modelRoles ?? "");
  const modelRolesError = modelRolesDraft !== null ? modelRolesDraftError(modelRolesDraft) : null;

  const rawValue = rawDraft ?? props.snapshot?.content ?? "";
  const rawDirty = rawDraft !== null;

  return (
    <div className="space-y-4 pt-3">
      <Alert className="py-2.5">
        <AlertDescription className="text-xs">
          Applies to new omp sessions — running sessions keep their current settings.
        </AlertDescription>
      </Alert>

      {props.loadError ? (
        <Alert variant="error">
          <AlertDescription className="text-xs">{props.loadError}</AlertDescription>
        </Alert>
      ) : null}
      {props.saveError ? (
        <Alert variant="error">
          <AlertDescription className="text-xs">{props.saveError}</AlertDescription>
        </Alert>
      ) : null}

      <ToggleGroup
        className="shrink-0"
        variant="outline"
        size="xs"
        value={[tab]}
        onValueChange={(value) => {
          const next = value[0];
          if (next === "curated" || next === "raw") {
            setTab(next);
          }
        }}
      >
        <Toggle aria-label="Curated config editor" value="curated">
          Curated
        </Toggle>
        <Toggle aria-label="Raw YAML editor" value="raw">
          Raw YAML
        </Toggle>
      </ToggleGroup>

      {tab === "curated" ? (
        <div className="space-y-3">
          {props.snapshot?.malformed ? (
            <Alert variant="warning">
              <AlertDescription className="text-xs">
                omp can't read this file until it's fixed — it runs on defaults. Switch to the Raw
                YAML tab, fix the YAML, and save.
              </AlertDescription>
            </Alert>
          ) : null}

          <div>
            <label className="block">
              <span className="text-xs font-medium text-foreground">Default thinking level</span>
              <Select
                value={curated?.defaultThinkingLevel ?? ""}
                disabled={disabled}
                onValueChange={(value) => {
                  if (curated) {
                    props.onSaveCurated({
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
                        Omit from config.yml — omp's own default applies.
                      </span>
                    </div>
                  </SelectItem>
                  {OMP_THINKING_LEVEL_OPTIONS.map((level) => (
                    <SelectItem
                      key={level.value}
                      value={level.value}
                      hideIndicator
                      className="min-w-56 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-foreground capitalize">
                          {level.label}
                        </span>
                        {level.description ? (
                          <span className="block text-xs text-muted-foreground">
                            {level.description}
                          </span>
                        ) : null}
                      </div>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
          </div>

          <div>
            <label className="block">
              <span className="text-xs font-medium text-foreground">Model roles</span>
              <Textarea
                className="mt-1.5 min-h-40 resize-y font-mono text-xs leading-relaxed"
                value={modelRolesValue}
                disabled={disabled}
                onChange={(event) => {
                  setModelRolesDraft(event.target.value);
                }}
                placeholder={
                  "default=anthropic/claude-sonnet-4-6\nsmol=opencode-go/deepseek-v4-flash:max"
                }
                spellCheck={false}
              />
            </label>
            {modelRolesError ? (
              <p className="mt-1 text-xs text-destructive">{modelRolesError}</p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                One <span className="font-mono">role=provider/model</span> line per model role.
                Empty = key omitted from config.yml.
              </p>
            )}
            <Button
              size="sm"
              className="mt-2"
              disabled={!modelRolesDirty || modelRolesError !== null || disabled}
              onClick={() => {
                if (curated) {
                  props.onSaveCurated({ ...curated, modelRoles: modelRolesValue });
                }
              }}
            >
              Save model roles
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <span className="text-xs font-medium text-foreground">Raw YAML</span>
          <Textarea
            className="mt-1.5 min-h-52 resize-y font-mono text-xs leading-relaxed"
            value={rawValue}
            disabled={disabled}
            onChange={(event) => {
              setRawDraft(event.target.value);
            }}
            placeholder=""
            spellCheck={false}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Whole-file editor — unknown and omp-managed keys are preserved on curated-field saves.
            Must be valid YAML; validated on the server before writing.
          </p>
          <Button
            size="sm"
            className="mt-2"
            disabled={!rawDirty || disabled}
            onClick={() => {
              if (rawDraft !== null) {
                props.onSaveRaw(rawDraft);
              }
            }}
          >
            Save raw YAML
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The "OMP config" editor inside an omp provider instance card. Edits the
 * instance's `config.yml` — `~/.omp/profiles/<name>/agent/config.yml` when
 * the instance sets a profile, else the agent home's file — via the
 * server's settings-file RPCs: a few curated fields plus a raw-YAML
 * whole-file editor, with two-way sync from the server's post-save
 * read-back. Config is read at omp process start, so changes apply on the
 * next session launch. Mobile has no provider settings surface, so this is
 * web/desktop only.
 */
export function OmpEnvironmentConfigSection(props: {
  environmentId: EnvironmentId | null;
  instanceId: string;
  /** The instance's OMP profile (empty = default profile). */
  profile: string;
}) {
  const getSettingsFile = useAtomCommand(serverEnvironment.ompGetSettingsFile, {
    reportFailure: false,
  });
  const updateSettingsFile = useAtomCommand(serverEnvironment.ompUpdateSettingsFile, {
    reportFailure: false,
  });

  const [isOpen, setIsOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<OmpSettingsFileSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
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
      input: { profile: props.profile },
    });
    setIsLoading(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setLoadError(
          failure instanceof Error ? failure.message : "Could not read the OMP config file.",
        );
      }
      hasLoadedRef.current = false;
      return;
    }
    setSnapshot(result.value);
    setSaveError(null);
  }, [getSettingsFile, props.environmentId, props.profile]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    void loadSnapshot();
  }, [isOpen, loadSnapshot]);

  const applySavedSnapshot = useCallback((next: OmpSettingsFileSnapshot) => {
    setSnapshot(next);
    setSaveError(null);
  }, []);

  const saveCurated = useCallback(
    async (curated: OmpSettingsFileCurated) => {
      if (!props.environmentId || isSaving) {
        return;
      }
      setIsSaving(true);
      setSaveError(null);
      try {
        const result = await updateSettingsFile({
          environmentId: props.environmentId,
          input: {
            profile: props.profile,
            mode: "curated",
            curated: toCuratedInput(curated),
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            setSaveError(
              failure instanceof Error ? failure.message : "Could not save the OMP config file.",
            );
          }
          return;
        }
        applySavedSnapshot(result.value);
        toastManager.add({
          type: "success",
          title: "OMP config saved",
          description: "Applies to new omp sessions.",
        });
      } finally {
        setIsSaving(false);
      }
    },
    [applySavedSnapshot, isSaving, props.environmentId, props.profile, updateSettingsFile],
  );

  const saveRaw = useCallback(
    async (content: string) => {
      if (!props.environmentId || isSaving) {
        return;
      }
      setIsSaving(true);
      setSaveError(null);
      try {
        const result = await updateSettingsFile({
          environmentId: props.environmentId,
          input: { profile: props.profile, mode: "raw", content },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            setSaveError(
              failure instanceof Error ? failure.message : "Could not save the OMP config file.",
            );
          }
          return;
        }
        applySavedSnapshot(result.value);
        toastManager.add({
          type: "success",
          title: "OMP config saved",
          description: "Applies to new omp sessions.",
        });
      } finally {
        setIsSaving(false);
      }
    },
    [applySavedSnapshot, isSaving, props.environmentId, props.profile, updateSettingsFile],
  );

  const fallbackPath = props.profile.trim()
    ? `~/.omp/profiles/${props.profile.trim()}/agent/config.yml`
    : "~/.omp/agent/config.yml";

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2.5 text-left">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs font-medium text-foreground">OMP config</span>
          <span className="text-xs text-muted-foreground">
            {snapshot?.path ?? fallbackPath}
            {props.profile.trim()
              ? " — this instance's profile"
              : " — OMP's default profile, shared by this machine"}
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
        <OmpEnvironmentConfigBody
          environmentId={props.environmentId}
          snapshot={snapshot}
          isLoading={isLoading}
          isSaving={isSaving}
          loadError={loadError}
          saveError={saveError}
          onSaveCurated={(curated) => void saveCurated(curated)}
          onSaveRaw={(content) => void saveRaw(content)}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}
