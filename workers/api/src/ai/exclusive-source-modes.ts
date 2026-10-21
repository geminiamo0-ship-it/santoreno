import { GroundedAiError } from "./errors";
import type { LibraryCatalogEntry } from "./library-catalog";

/** Exclusive answer modes. Gallery is an auxiliary image index, never evidence.
 * Research mode is handled by the unchanged PubMed adapter. */
export type ExclusiveSantoMode = "amboss" | "usmle" | "mrcp" | "anking";
export const ANKING_V12_INSTANCE = "santo-anking-step-v12";
export const GALLERY_INSTANCE = "santo-medical-images";

export function isExclusiveMode(value: string | null): value is ExclusiveSantoMode {
  return value === "amboss" || value === "usmle" || value === "mrcp" || value === "anking";
}

export function exclusiveModeLibraries(
  catalog: readonly LibraryCatalogEntry[],
  mode: ExclusiveSantoMode,
  ankingEnabled: boolean,
): LibraryCatalogEntry[] {
  if (mode === "anking") {
    if (!ankingEnabled)
      throw new GroundedAiError(503, "SEARCH_CONFIGURATION_ERROR", "AnKing mode unavailable");
    // Full licensed AnKing note index is separate from the 5 clinical sources.
    return [{ id: "anking", title: "AnKing v12", instanceId: ANKING_V12_INSTANCE }];
  }
  const ids = mode === "mrcp" ? ["passmedicine", "pastest", "one-examination"] : [mode];
  const entries = ids.map((id) => catalog.find((library) => library.id === id));
  if (entries.some((entry) => !entry)) {
    throw new GroundedAiError(
      503,
      "SEARCH_CONFIGURATION_ERROR",
      "Selected medical index unavailable",
    );
  }
  return entries as LibraryCatalogEntry[];
}
