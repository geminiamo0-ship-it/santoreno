/** Only prettify a confirmed R2 key. Never derive a medical article title from a slug. */
export function readableMedicalSourceTitle(title: string): string {
  const match =
    /^medical-search\/v1\/(amboss|usmle|passmedicine|pastest|one-examination)\/([a-z0-9-]+)\/s-(\d{4})\.md$/.exec(
      title,
    );
  if (!match) return title;
  const labels: Record<string, string> = {
    amboss: "AMBOSS",
    usmle: "USMLE",
    passmedicine: "PassMedicine",
    pastest: "Pastest",
    "one-examination": "One Examination",
  };
  const library = match[1] ?? "";
  return `${labels[library] ?? library} · Article ${match[2]} · Section ${Number(match[3])}`;
}
