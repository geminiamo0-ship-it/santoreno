export interface WidgetUiState {
  expanded: boolean;
  fullscreen: boolean;
  libraryId: string | null;
  sourceMode: "libraries" | "research";
}

export const INITIAL_WIDGET_UI_STATE: WidgetUiState = {
  expanded: false,
  fullscreen: false,
  libraryId: null,
  sourceMode: "libraries",
};

export type WidgetUiAction =
  | { type: "toggle" }
  | { type: "close" }
  | { type: "fullscreen" }
  | { type: "library"; libraryId: string | null }
  | { type: "source-mode"; sourceMode: "libraries" | "research" };

export function reduceWidgetUi(state: WidgetUiState, action: WidgetUiAction): WidgetUiState {
  if (action.type === "close") {
    return { ...state, expanded: false, fullscreen: false };
  }
  if (action.type === "toggle") {
    return { ...state, expanded: !state.expanded, fullscreen: false };
  }
  if (action.type === "fullscreen") {
    return { ...state, expanded: true, fullscreen: !state.fullscreen };
  }
  if (action.type === "source-mode") {
    return {
      ...state,
      sourceMode: action.sourceMode,
      libraryId: action.sourceMode === "research" ? null : state.libraryId,
    };
  }
  if (action.libraryId !== null && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(action.libraryId)) {
    return state;
  }
  return { ...state, libraryId: action.libraryId };
}
